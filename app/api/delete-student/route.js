import { adminDb } from "@/lib/firebaseAdmin";
import admin from "firebase-admin";
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withAdminAuth, withRateLimit, validateInput } from "@/lib/apiAuth";
import { z } from 'zod';

// Input validation schema
const deleteStudentSchema = z.object({
  id: z.string().optional(),
  uid: z.string().optional(),
  email: z.string().email().optional()
}).refine(data => data.id || data.uid || data.email, {
  message: "At least one identifier (id, uid, or email) is required"
});

async function deleteStudentHandler(request) {
  try {
    const { id, uid: uidFromClient, email: emailFromClient } = request.validatedBody;
    // Input validation is now handled by middleware

    const studentsCol = adminDb.collection("students");
    let docRef = id ? studentsCol.doc(id) : null;
    let snap = docRef ? await docRef.get() : null;

    // If not found by id, try by uid
    if (!snap || !snap.exists) {
      if (uidFromClient) {
        const byUid = await studentsCol.where("uid", "==", uidFromClient).limit(1).get();
        if (!byUid.empty) {
          docRef = byUid.docs[0].ref;
          snap = byUid.docs[0];
        }
      }
    }

    // If still not found, try by normalized email
    if (!snap || !snap.exists) {
      if (emailFromClient) {
        const email = String(emailFromClient).trim().toLowerCase();
        const [local, domain] = email.split("@");
        let normalized = email;
        if (local && domain) {
          if (domain === "gmail.com" || domain === "googlemail.com") {
            const plusIndex = local.indexOf("+");
            const withoutPlus = plusIndex === -1 ? local : local.slice(0, plusIndex);
            const withoutDots = withoutPlus.replace(/\./g, "");
            normalized = `${withoutDots}@gmail.com`;
          } else {
            normalized = `${local}@${domain}`;
          }
        }
        const byEmail = await studentsCol.where("emailNormalized", "==", normalized).limit(1).get();
        if (!byEmail.empty) {
          docRef = byEmail.docs[0].ref;
          snap = byEmail.docs[0];
        }
      }
    }

    if (!snap || !snap.exists) {
      return new Response(JSON.stringify({ error: "Student not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = snap.data();
    const uid = data?.uid || uidFromClient || null;

    if (uid) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (authErr) {
        const msg = String(authErr?.message || '');
        const isDecoderError = msg.includes('DECODER routines') || authErr.code === 'ERR_OSSL_UNSUPPORTED' || msg.includes('1E08010C');
        if (authErr?.code === "auth/user-not-found") {
          // Ignore if user is already gone
        } else if (isDecoderError) {
          console.warn("⚠️ Skipping Auth user deletion due to OpenSSL DECODER error. Proceeding with Firestore delete.");
        } else {
          console.warn("Failed to delete auth user:", authErr);
        }
      }
    }

    // Try Admin SDK delete first
    let deletedViaRest = false;
    try {
      try {
        const paymentsRef = docRef.collection("payments");
        const paymentsSnap = await paymentsRef.get();
        const batch = adminDb.batch();
        paymentsSnap.forEach((p) => batch.delete(p.ref));
        await batch.commit();
      } catch (subErr) {
        const msg = String(subErr?.message || '');
        const isDecoderError = msg.includes('DECODER routines') || subErr.code === 'ERR_OSSL_UNSUPPORTED' || msg.includes('1E08010C');
        if (isDecoderError) {
          console.warn('⚠️ Skipping subcollection deletion due to OpenSSL DECODER error. Will proceed to delete main doc.');
        } else {
          console.warn("Failed to delete subcollections:", subErr);
        }
      }

      await docRef.delete();
    } catch (fsDeleteErr) {
      // Fallback to Firestore REST API in development
      const msg = String(fsDeleteErr?.message || '');
      const isDecoderError = msg.includes('DECODER routines') || fsDeleteErr.code === 'ERR_OSSL_UNSUPPORTED' || msg.includes('1E08010C');
      if (isDecoderError && process.env.NODE_ENV === 'development') {
        console.warn('❌ OpenSSL DECODER error during Firestore delete. Attempting REST API fallback...');

        try {
          // Read service account
          const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
          const saJson = fs.readFileSync(serviceAccountPath, 'utf8');
          const sa = JSON.parse(saJson);

          // Build JWT
          const now = Math.floor(Date.now() / 1000);
          const header = { alg: 'RS256', typ: 'JWT' };
          const payload = {
            iss: sa.client_email,
            sub: sa.client_email,
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now,
            scope: 'https://www.googleapis.com/auth/datastore'
          };
          const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+/g,'');
          const unsigned = `${b64url(header)}.${b64url(payload)}`;
          const sign = crypto.createSign('RSA-SHA256');
          sign.update(unsigned);
          const signature = sign.sign(sa.private_key.replace(/\\n/g,'\n'),'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+/g,'');
          const assertion = `${unsigned}.${signature}`;

          // Exchange for access token
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`
          });
          if (!tokenRes.ok) throw new Error(await tokenRes.text());
          const { access_token } = await tokenRes.json();

          const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || sa.project_id;
          const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/students/${docRef.id}`;
          const delRes = await fetch(restUrl, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${access_token}` }
          });
          if (!delRes.ok) throw new Error(await delRes.text());
          deletedViaRest = true;
          console.log('✅ Student deleted via REST API fallback:', docRef.id);
        } catch (restErr) {
          console.error('❌ Firestore REST delete fallback failed:', restErr?.message || restErr);
          throw fsDeleteErr; // rethrow original
        }
      } else {
        throw fsDeleteErr;
      }
    }

    // Add audit trail
    console.log(`Student deleted by ${request.user.email}: ${id || uid || emailFromClient}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        deletedId: id, 
        deletedUid: uid || null,
        deletedBy: request.user.email,
        note: deletedViaRest ? 'Deleted via REST API fallback' : undefined
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("Delete student error:", e);
    return new Response(
      JSON.stringify({ error: e.message || "Failed to delete student" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Apply security middleware: Admin auth + Rate limiting + Input validation
export async function POST(request) {
  return await withAdminAuth(request, (req1) =>
    withRateLimit(30, 15 * 60 * 1000)(req1, (req2) =>
      validateInput(deleteStudentSchema)(req2, deleteStudentHandler)
    )
  );
}
