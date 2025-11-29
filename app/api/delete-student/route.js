import { adminDb } from "@/lib/firebaseAdmin";
import admin from "firebase-admin";
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withAdminAuth, withRateLimit, validateInput } from "@/lib/apiAuth";
import { z } from 'zod';

let cachedServiceAccount = null;

function loadServiceAccount() {
  if (cachedServiceAccount) return cachedServiceAccount;

  let serviceAccountJson = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      serviceAccountJson = Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
        'base64'
      ).toString('utf8');
    } catch (error) {
      console.warn('Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64:', error?.message || error);
    }
  }

  if (!serviceAccountJson && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }

  if (!serviceAccountJson) {
    const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
    serviceAccountJson = fs.readFileSync(serviceAccountPath, 'utf8');
  }

  cachedServiceAccount = JSON.parse(serviceAccountJson);
  if (
    cachedServiceAccount.private_key &&
    cachedServiceAccount.private_key.includes('\\n')
  ) {
    cachedServiceAccount.private_key = cachedServiceAccount.private_key.replace(/\\n/g, '\n');
  }
  return cachedServiceAccount;
}

function encodeBase64Url(input) {
  const value = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+/g, '');
}

async function getGoogleAccessToken(scopes = ['https://www.googleapis.com/auth/datastore']) {
  const serviceAccount = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const scopeString = Array.isArray(scopes) ? scopes.join(' ') : scopes;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    scope: scopeString
  };

  const unsigned = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign
    .sign(serviceAccount.private_key, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+/g, '');
  const assertion = `${unsigned}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(errText || 'Failed to fetch Google OAuth token');
  }

  const { access_token } = await tokenRes.json();
  if (!access_token) {
    throw new Error('OAuth token response missing access_token');
  }

  return { accessToken: access_token, serviceAccount };
}

async function deleteAuthUserViaRest(uid) {
  try {
    const { accessToken, serviceAccount } = await getGoogleAccessToken('https://www.googleapis.com/auth/identitytoolkit');
    const projectId =
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_PROJECT_ID ||
      serviceAccount.project_id;

    const restUrl = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:delete`;
    const restRes = await fetch(restUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ localId: uid })
    });

    if (!restRes.ok) {
      const errText = await restRes.text();
      throw new Error(errText || `REST delete failed for uid ${uid}`);
    }

    console.log('✅ Auth user deleted via REST API fallback:', uid);
    return true;
  } catch (error) {
    console.error('❌ Auth REST delete fallback failed:', error?.message || error);
    return false;
  }
}

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
          console.warn("⚠️ Auth user deletion hit OpenSSL DECODER error. Attempting REST fallback...");
          const restDeleted = await deleteAuthUserViaRest(uid);
          if (!restDeleted) {
            throw new Error("Failed to delete Firebase Auth user due to OpenSSL compatibility issue. REST fallback also failed.");
          }
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
          const { accessToken, serviceAccount } = await getGoogleAccessToken('https://www.googleapis.com/auth/datastore');
          const projectId =
            process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
            process.env.FIREBASE_PROJECT_ID ||
            serviceAccount.project_id;
          const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/students/${docRef.id}`;
          const delRes = await fetch(restUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` }
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
