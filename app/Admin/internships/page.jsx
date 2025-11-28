"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { auth, db, firestoreHelpers } from "../../../lib/firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";

export default function InternshipManager() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  const [internships, setInternships] = useState([]);
  const [selectedInternshipId, setSelectedInternshipId] = useState("");
  const [creating, setCreating] = useState(false);
  const [copyingCourseId, setCopyingCourseId] = useState("");
  const [selectedCourseIds, setSelectedCourseIds] = useState([]);
  const [bulkCopying, setBulkCopying] = useState(false);
  const [internshipCourses, setInternshipCourses] = useState([]);
  const [deletingCourseId, setDeletingCourseId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletingInternshipId, setDeletingInternshipId] = useState("");

  const [newInternship, setNewInternship] = useState({
    name: "",
    description: "",
  });

  const [courses, setCourses] = useState([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const ref = firestoreHelpers.doc(db, "users", u.uid);
        const snap = await firestoreHelpers.getDoc(ref);
        const role = snap.exists() ? snap.data().role : null;
        setIsAdmin(role === "admin" || role === "superadmin");
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchInternships();
    fetchCourses();
  }, [user, fetchInternships, fetchCourses]);

  useEffect(() => {
    if (!selectedInternshipId) {
      setInternshipCourses([]);
      return;
    }
    fetchInternshipCourses(selectedInternshipId);
  }, [selectedInternshipId]);

  const fetchInternships = useCallback(async function fetchInternships() {
    const snap = await firestoreHelpers.getDocs(
      firestoreHelpers.collection(db, "internships")
    );
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setInternships(list);
    if (!selectedInternshipId && list.length > 0) {
      setSelectedInternshipId(list[0].id);
    }
  }, [selectedInternshipId]);

  async function deleteCourseFromInternship(courseId) {
    if (!selectedInternshipId || !courseId) return;
    if (!confirm("Delete this course from the internship? This will also remove its chapters.")) return;
    try {
      setDeletingCourseId(courseId);
      // delete chapters
      const chaptersSnap = await firestoreHelpers.getDocs(
        firestoreHelpers.collection(
          db,
          "internships",
          selectedInternshipId,
          "courses",
          courseId,
          "chapters"
        )
      );
      for (const ch of chaptersSnap.docs) {
        await firestoreHelpers.deleteDoc(
          firestoreHelpers.doc(
            db,
            "internships",
            selectedInternshipId,
            "courses",
            courseId,
            "chapters",
            ch.id
          )
        );
      }
      // delete course copy
      await firestoreHelpers.deleteDoc(
        firestoreHelpers.doc(db, "internships", selectedInternshipId, "courses", courseId)
      );
      await fetchInternshipCourses(selectedInternshipId);
    } catch (e) {
      console.error(e);
      alert("Failed to delete course from internship.");
    } finally {
      setDeletingCourseId("");
    }
  }

  async function fetchInternshipCourses(internshipId) {
    const snap = await firestoreHelpers.getDocs(
      firestoreHelpers.collection(db, "internships", internshipId, "courses")
    );
    setInternshipCourses(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  const fetchCourses = useCallback(async function fetchCourses() {
    const snap = await firestoreHelpers.getDocs(
      firestoreHelpers.collection(db, "courses")
    );
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    setCourses(list);
  }, []);

  async function createInternship(e) {
    e.preventDefault();
    if (!newInternship.name.trim()) return;
    try {
      setCreating(true);
      const ref = await firestoreHelpers.addDoc(
        firestoreHelpers.collection(db, "internships"),
        {
          name: newInternship.name.trim(),
          description: newInternship.description.trim(),
          createdAt: new Date().toISOString(),
          createdBy: user?.uid || null,
        }
      );
      setNewInternship({ name: "", description: "" });
      await fetchInternships();
      setSelectedInternshipId(ref.id);
    } finally {
      setCreating(false);
    }
  }

  async function copyCourseToInternship(course) {
    if (!selectedInternshipId) return;
    try {
      setCopyingCourseId(course.id);
      // 1) Create course copy
      const courseCopyRef = await firestoreHelpers.addDoc(
        firestoreHelpers.collection(
          db,
          "internships",
          selectedInternshipId,
          "courses"
        ),
        {
          title: course.title || "",
          description: course.description || "",
          courseCode: course.courseCode || "",
          syllabus: Array.isArray(course.syllabus) ? course.syllabus : [],
          sourceCourseId: course.id,
          copiedAt: new Date().toISOString(),
          copiedBy: user?.uid || null,
        }
      );

      // 2) Copy chapters
      const masterChaptersSnap = await firestoreHelpers.getDocs(
        firestoreHelpers.collection(db, "courses", course.id, "chapters")
      );
      const chapters = masterChaptersSnap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
      await Promise.all(
        chapters.map((ch) => {
          const { id: _omitId, ...payload } = ch;
          return firestoreHelpers.addDoc(
            firestoreHelpers.collection(
              db,
              "internships",
              selectedInternshipId,
              "courses",
              courseCopyRef.id,
              "chapters"
            ),
            {
              ...payload,
              copiedFromChapterId: _omitId,
              copiedAt: new Date().toISOString(),
            }
          );
        })
      );
      alert("Course copied to internship.");
    } catch (e) {
      console.error(e);
      alert("Failed to copy course.");
    } finally {
      setCopyingCourseId("");
    }
  }

  async function copyCourseToInternshipSilently(course) {
    // Same as copyCourseToInternship but without UI spinners/alerts
    if (!selectedInternshipId) return;
    // 1) Create course copy
    const courseCopyRef = await firestoreHelpers.addDoc(
      firestoreHelpers.collection(
        db,
        "internships",
        selectedInternshipId,
        "courses"
      ),
      {
        title: course.title || "",
        description: course.description || "",
        courseCode: course.courseCode || "",
        syllabus: Array.isArray(course.syllabus) ? course.syllabus : [],
        sourceCourseId: course.id,
        copiedAt: new Date().toISOString(),
        copiedBy: user?.uid || null,
      }
    );

    // 2) Copy chapters
    const masterChaptersSnap = await firestoreHelpers.getDocs(
      firestoreHelpers.collection(db, "courses", course.id, "chapters")
    );
    const chapters = masterChaptersSnap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
    await Promise.all(
      chapters.map((ch) => {
        const { id: _omitId, ...payload } = ch;
        return firestoreHelpers.addDoc(
          firestoreHelpers.collection(
            db,
            "internships",
            selectedInternshipId,
            "courses",
            courseCopyRef.id,
            "chapters"
          ),
          {
            ...payload,
            copiedFromChapterId: _omitId,
            copiedAt: new Date().toISOString(),
          }
        );
      })
    );
  }

  function toggleCourseSelection(courseId) {
    setSelectedCourseIds((prev) =>
      prev.includes(courseId)
        ? prev.filter((id) => id !== courseId)
        : [...prev, courseId]
    );
  }

  function clearSelectedCourses() {
    setSelectedCourseIds([]);
  }

  async function copySelectedCoursesToInternship() {
    if (!selectedInternshipId || selectedCourseIds.length === 0) return;
    try {
      setBulkCopying(true);
      const map = new Map(courses.map((c) => [c.id, c]));
      await Promise.all(
        selectedCourseIds.map((id) => {
          const course = map.get(id);
          return course ? copyCourseToInternshipSilently(course) : Promise.resolve();
        })
      );
      clearSelectedCourses();
      alert("Selected courses copied to internship.");
    } catch (e) {
      console.error(e);
      alert("Failed to copy selected courses.");
    } finally {
      setBulkCopying(false);
    }
  }

  // Managed actions (delete internship/courses) live elsewhere now
  async function deleteInternship(id) {
    const targetId = id || selectedInternshipId;
    if (!targetId) return;
    if (!confirm("Are you sure you want to delete this internship? This will remove its copied courses and chapters.")) return;
    try {
      setDeleting(true);
      setDeletingInternshipId(targetId);

      // Delete courses and their chapters under the internship
      const coursesSnap = await firestoreHelpers.getDocs(
        firestoreHelpers.collection(db, "internships", targetId, "courses")
      );
      for (const courseDoc of coursesSnap.docs) {
        const chaptersSnap = await firestoreHelpers.getDocs(
          firestoreHelpers.collection(
            db,
            "internships",
            targetId,
            "courses",
            courseDoc.id,
            "chapters"
          )
        );
        for (const ch of chaptersSnap.docs) {
          await firestoreHelpers.deleteDoc(
            firestoreHelpers.doc(
              db,
              "internships",
              targetId,
              "courses",
              courseDoc.id,
              "chapters",
              ch.id
            )
          );
        }
        await firestoreHelpers.deleteDoc(
          firestoreHelpers.doc(db, "internships", targetId, "courses", courseDoc.id)
        );
      }

      // Delete internship itself
      await firestoreHelpers.deleteDoc(
        firestoreHelpers.doc(db, "internships", targetId)
      );

      if (selectedInternshipId === targetId) {
        setSelectedInternshipId("");
        setInternshipCourses([]);
      }
      await fetchInternships();
      alert("Internship deleted.");
    } catch (e) {
      console.error(e);
      alert("Failed to delete internship.");
    } finally {
      setDeleting(false);
      setDeletingInternshipId("");
    }
  }

  function logout() {
    signOut(auth);
  }

  if (loading) return <div>Loading...</div>;
  if (!user || !isAdmin) return <div>Access Denied</div>;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Internship Manager</h1>
          <p className="text-sm text-slate-600">
            Copy master courses into internships and edit copies safely.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => router.push("/Admin")}
            className="px-3 py-2 rounded-md bg-slate-100 hover:bg-slate-200"
          >
            Back
          </button>
          <button
            onClick={logout}
            className="px-3 py-2 rounded-md bg-red-600 text-white hover:bg-red-700"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-semibold mb-3">Create Internship</h2>
            <form onSubmit={createInternship} className="space-y-3">
              <input
                type="text"
                placeholder="Name"
                value={newInternship.name}
                onChange={(e) =>
                  setNewInternship((s) => ({ ...s, name: e.target.value }))
                }
                className="w-full rounded-md border px-3 py-2"
              />
              <textarea
                placeholder="Description"
                value={newInternship.description}
                onChange={(e) =>
                  setNewInternship((s) => ({
                    ...s,
                    description: e.target.value,
                  }))
                }
                className="w-full rounded-md border px-3 py-2"
                rows={3}
              />
              <button
                disabled={creating}
                className="px-4 py-2 rounded-md bg-emerald-600 text-white disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </form>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-semibold mb-3">Select Internship</h2>
            <select
              value={selectedInternshipId}
              onChange={(e) => setSelectedInternshipId(e.target.value)}
              className="w-full rounded-md border px-3 py-2"
            >
              {internships.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name || i.id}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-semibold mb-3">Internships</h2>
            <div className="space-y-3">
              {internships.length === 0 && (
                <div className="text-sm text-slate-500">No internships yet.</div>
              )}
              {internships.map((i) => (
                <div
                  key={i.id}
                  className={`border rounded-md px-3 py-2 flex items-center justify-between ${selectedInternshipId === i.id ? "bg-blue-50" : ""}`}
                >
                  <button
                    onClick={() => setSelectedInternshipId(i.id)}
                    className="text-left"
                  >
                    <div className="font-medium">{i.name || i.id}</div>
                    {i.description && (
                      <div className="text-xs text-slate-500 line-clamp-1">
                        {i.description}
                      </div>
                    )}
                  </button>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/Admin/internships/${i.id}/manage`}
                      className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm"
                    >
                      Manage
                    </Link>
                    <button
                      onClick={() => deleteInternship(i.id)}
                      disabled={deleting && deletingInternshipId === i.id}
                      className="px-3 py-1.5 rounded-md bg-red-600 text-white text-sm disabled:opacity-50"
                    >
                      {deleting && deletingInternshipId === i.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>


        </div>

        <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">Master Courses</h2>
              {selectedCourseIds.length > 0 && (
                <span className="text-xs px-2 py-1 rounded bg-slate-100">
                  Selected: {selectedCourseIds.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copySelectedCoursesToInternship}
                disabled={
                  !selectedInternshipId ||
                  selectedCourseIds.length === 0 ||
                  bulkCopying
                }
                className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50"
              >
                {bulkCopying ? "Copying..." : "Copy Selected to Internship"}
              </button>
              <button
                onClick={clearSelectedCourses}
                disabled={selectedCourseIds.length === 0 || bulkCopying}
                className="px-3 py-2 rounded-md bg-slate-100 text-sm disabled:opacity-50"
              >
                Clear
              </button>
              {!selectedInternshipId && (
                <div className="text-sm text-amber-600">
                  Select an internship to enable copying.
                </div>
              )}
            </div>
          </div>

          

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {courses.map((c) => (
              <div
                key={c.id}
                className="border rounded-lg p-3 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedCourseIds.includes(c.id)}
                      onChange={() => toggleCourseSelection(c.id)}
                      className="h-4 w-4"
                    />
                    <div className="font-semibold">{c.title || "Untitled"}</div>
                  </div>
                  <div className="text-xs text-slate-500">
                    {c.courseCode || ""}
                  </div>
                  <p className="mt-1 text-sm text-slate-600 line-clamp-3">
                    {c.description || ""}
                  </p>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    disabled={!selectedInternshipId || copyingCourseId === c.id}
                    onClick={() => copyCourseToInternship(c)}
                    className="px-3 py-2 rounded-md bg-emerald-600 text-white disabled:opacity-50"
                  >
                    {copyingCourseId === c.id
                      ? "Copying..."
                      : "Copy to Internship"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


