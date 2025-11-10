"use client";

import { useEffect, useState } from "react";
import { auth, db } from "../../lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, collection, getDocs, setDoc, serverTimestamp, updateDoc, query, where, arrayUnion } from "firebase/firestore";
import CheckTrainerAuth from "@/lib/CheckTrainerAuth";

export default function TrainerHome() {
  const [userId, setUserId] = useState("");
  const [classes, setClasses] = useState([]);
  const [courses, setCourses] = useState([]);
  const [students, setStudents] = useState([]);
  const [allowedClasses, setAllowedClasses] = useState([]);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [classCourses, setClassCourses] = useState([]);
  const [unlockStatus, setUnlockStatus] = useState("");
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [showChapterModal, setShowChapterModal] = useState(false);
  const [selectedCourseForUnlock, setSelectedCourseForUnlock] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [selectedChapters, setSelectedChapters] = useState([]);
  const [unlockStudents, setUnlockStudents] = useState(false);
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);
  const [attendanceCourse, setAttendanceCourse] = useState(null);
  const [attendanceChapterId, setAttendanceChapterId] = useState("");
  const [attendanceSelectedIds, setAttendanceSelectedIds] = useState([]);
  const [attendanceSaving, setAttendanceSaving] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) return;
      setUserId(u.uid);
      const uSnap = await getDoc(doc(db, "users", u.uid));
      const data = uSnap.exists() ? uSnap.data() : {};
      setAllowedClasses(data.trainerClasses || []);
      // Trainer-level course assignment not used for class view

      const [cSnap, crSnap] = await Promise.all([
        getDocs(collection(db, "classes")),
        getDocs(collection(db, "courses")),
      ]);
      setClasses(cSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      const allCourses = crSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setCourses(allCourses);

      // Load all students once for attendance
      try {
        const sSnap = await getDocs(collection(db, "students"));
        setStudents(sSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } catch (_) {}
      // Do not auto-select a class; require explicit click
    });
    return () => unsub();
  }, []);

  // Load class-based courses after selecting a class
  useEffect(() => {
    async function loadClassCourses() {
      if (!selectedClassId) { setClassCourses([]); return; }
      try {
        const cRef = doc(db, 'classes', selectedClassId);
        const cSnap = await getDoc(cRef);
        if (!cSnap.exists()) { setClassCourses([]); return; }
        const cData = cSnap.data() || {};
        const ids = Array.isArray(cData.courseIds) ? cData.courseIds : [];
        const titles = Array.isArray(cData.courseTitles) ? cData.courseTitles : [];
        const byId = new Map(courses.map((x) => [x.id, x]));
        const list = ids.map((id, idx) => {
          const found = byId.get(id);
          return found ? found : { id, title: titles[idx] || cData.name || id };
        });
        setClassCourses(list);
      } catch {
        setClassCourses([]);
      }
    }
    loadClassCourses();
  }, [selectedClassId, courses]);

  // Load chapters for a course
  const loadChapters = async (courseId) => {
    if (!courseId) {
      setChapters([]);
      setSelectedChapters([]);
      return;
    }
    try {
      const snap = await getDocs(collection(db, "courses", courseId, "chapters"));
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => {
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        if (a.order !== undefined) return -1;
        if (b.order !== undefined) return 1;
        return 0;
      });
      setChapters(items);

      // Preselect chapters that were already unlocked by this trainer today for this course
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      if (userId) {
        const trainerKey = `trainer:${userId}`;
        const unlocksCol = collection(db, 'unlocks');
        const qUnlocked = query(unlocksCol, where('key', '==', trainerKey), where('courseId', '==', courseId), where('date', '==', ymd));
        const unlockedSnap = await getDocs(qUnlocked);
        const unlockedChapterIds = unlockedSnap.docs
          .map((d) => d.data()?.chapterId)
          .filter(Boolean);
        setSelectedChapters(unlockedChapterIds);
      } else {
        setSelectedChapters([]);
      }
    } catch (error) {
      console.error("Error loading chapters:", error);
      setChapters([]);
    }
  };

  // Unlock functionality
  const unlockToday = async (courseId = null) => {
    setUnlockLoading(true);
    setUnlockStatus("");
    try {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      
      const classKey = selectedClassId ? `class:${selectedClassId}` : null;
      const courseKey = courseId ? `course:${courseId}` : null;
      const trainerKey = userId ? `trainer:${userId}` : null;

      if (courseId && selectedChapters.length > 0) {
        // Unlock specific chapters for class, course and trainer
        for (const chId of selectedChapters) {
          if (unlockStudents && classKey) {
            const ref = doc(db, "unlocks", `${classKey}|chapter:${chId}|${ymd}`);
            await setDoc(ref, { key: classKey, chapterId: chId, date: ymd, createdAt: serverTimestamp() }, { merge: true });
          }
          if (unlockStudents && courseKey) {
            const ref = doc(db, "unlocks", `${courseKey}|chapter:${chId}|${ymd}`);
            await setDoc(ref, { key: courseKey, chapterId: chId, date: ymd, createdAt: serverTimestamp() }, { merge: true });
          }
          if (trainerKey) {
            const ref = doc(db, "unlocks", `${trainerKey}|course:${courseId}|chapter:${chId}|${ymd}`);
            await setDoc(ref, { key: trainerKey, courseId, chapterId: chId, date: ymd, createdAt: serverTimestamp() }, { merge: true });
          }
        }

        // Also write per-student chapterAccess when unlocking chapters
        if (unlockStudents && selectedClassId && courseId) {
          // Fetch students in this class by both schemas (classId and classIds contains)
          const studentsCol = collection(db, 'students');
          const q1 = query(studentsCol, where('classId', '==', selectedClassId));
          const q2 = query(studentsCol, where('classIds', 'array-contains', selectedClassId));
          const [s1, s2] = await Promise.all([getDocs(q1), getDocs(q2)]);
          const seen = new Set();
          const studentDocs = [];
          [...s1.docs, ...s2.docs].forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); studentDocs.push(d); } });

          // Update each student's chapterAccess for the selected course
          const updates = [];
          for (const sd of studentDocs) {
            const sRef = doc(db, 'students', sd.id);
            for (const chId of selectedChapters) {
              updates.push(updateDoc(sRef, { [`chapterAccess.${courseId}`]: arrayUnion(chId) }));
            }
          }
          // Run updates in parallel and fail if any fails
          await Promise.all(updates);

          // Set due dates for progress tests associated with unlocked chapters (3 days from today)
          const dueDate = new Date(today);
          dueDate.setDate(dueDate.getDate() + 3);
          const dueDateString = dueDate.toISOString().split('T')[0];
          
          // Get all chapters to map chapter IDs to their order
          const chaptersSnap = await getDocs(collection(db, 'courses', courseId, 'chapters'));
          const chapterMap = new Map();
          chaptersSnap.docs.forEach(doc => {
            const data = doc.data();
            chapterMap.set(doc.id, data.order || 0);
          });

          // Get all assignments for this course
          const assignmentsSnap = await getDocs(collection(db, 'courses', courseId, 'assignments'));
          
          // Update due dates for assignments matching the unlocked chapters
          const assignmentUpdates = [];
          for (const assignmentDoc of assignmentsSnap.docs) {
            const assignmentData = assignmentDoc.data();
            const assignmentDay = assignmentData.day || 1;
            
            // Check if this assignment corresponds to any of the unlocked chapters
            for (const chId of selectedChapters) {
              const chapterOrder = chapterMap.get(chId);
              if (chapterOrder === assignmentDay) {
                const assignmentRef = doc(db, 'courses', courseId, 'assignments', assignmentDoc.id);
                assignmentUpdates.push(
                  updateDoc(assignmentRef, { dueDate: dueDateString, unlockDate: ymd })
                );
                break;
              }
            }
          }
          
          if (assignmentUpdates.length > 0) {
            await Promise.all(assignmentUpdates);
          }
        }
        setUnlockStatus(`Unlocked ${selectedChapters.length} chapters for today.`);
      } else {
        // Unlock entire day for class, and also mark course and trainer if provided
        if (unlockStudents && classKey) {
          const ref = doc(db, "unlocks", `${classKey}|${ymd}`);
          await setDoc(ref, { key: classKey, date: ymd, createdAt: serverTimestamp() }, { merge: true });
        }
        if (unlockStudents && courseKey) {
          const ref = doc(db, "unlocks", `${courseKey}|${ymd}`);
          await setDoc(ref, { key: courseKey, date: ymd, createdAt: serverTimestamp() }, { merge: true });
        }
        if (trainerKey) {
          const ref = doc(db, "unlocks", `${trainerKey}${courseId ? `|course:${courseId}` : ""}|${ymd}`);
          await setDoc(ref, { key: trainerKey, ...(courseId ? { courseId } : {}), date: ymd, createdAt: serverTimestamp() }, { merge: true });
        }

        // If a course is provided and students should be unlocked, give students access to all chapters
        if (unlockStudents && selectedClassId && courseId) {
          try {
            const chaptersSnap = await getDocs(collection(db, 'courses', courseId, 'chapters'));
            const chapterIds = chaptersSnap.docs.map((d) => d.id);
            const studentsCol = collection(db, 'students');
            const q1 = query(studentsCol, where('classId', '==', selectedClassId));
            const q2 = query(studentsCol, where('classIds', 'array-contains', selectedClassId));
            const [s1, s2] = await Promise.all([getDocs(q1), getDocs(q2)]);
            const seen = new Set();
            const studentDocs = [];
            [...s1.docs, ...s2.docs].forEach((d) => { if (!seen.has(d.id)) { seen.add(d.id); studentDocs.push(d); } });
            const updates = [];
            for (const sd of studentDocs) {
              const sRef = doc(db, 'students', sd.id);
              for (const chId of chapterIds) {
                updates.push(updateDoc(sRef, { [`chapterAccess.${courseId}`]: arrayUnion(chId) }));
              }
            }
            await Promise.all(updates);

            // Set due dates for all progress tests (3 days from today)
            const dueDate = new Date(today);
            dueDate.setDate(dueDate.getDate() + 3);
            const dueDateString = dueDate.toISOString().split('T')[0];
            
            // Update all assignments for this course
            const assignmentsSnap = await getDocs(collection(db, 'courses', courseId, 'assignments'));
            const assignmentUpdates = assignmentsSnap.docs.map(assignmentDoc => {
              const assignmentRef = doc(db, 'courses', courseId, 'assignments', assignmentDoc.id);
              return updateDoc(assignmentRef, { dueDate: dueDateString, unlockDate: ymd });
            });
            
            if (assignmentUpdates.length > 0) {
              await Promise.all(assignmentUpdates);
            }
          } catch (e) {
            throw e;
          }
        }
        setUnlockStatus("Unlocked for today.");
      }
    } catch (error) {
      setUnlockStatus(error.message || "Failed to unlock");
    } finally {
      setUnlockLoading(false);
    }
  };

  // Handle class unlock
 

  // Handle course unlock
  const handleCourseUnlock = async (course) => {
    if (!selectedClassId) {
      setUnlockStatus('Please select a class first.');
      return;
    }
    setSelectedCourseForUnlock(course);
    await loadChapters(course.id);
    setShowChapterModal(true);
  };

  // Handle chapter selection and unlock
  const handleChapterUnlock = async () => {
    if (selectedCourseForUnlock) {
      await unlockToday(selectedCourseForUnlock.id);
      setShowChapterModal(false);
      setSelectedChapters([]);
      setSelectedCourseForUnlock(null);
    }
  };

  // Attendance helpers
  const openAttendanceForCourse = async (course) => {
    if (!selectedClassId) {
      setUnlockStatus('Please select a class first.');
      return;
    }
    setAttendanceCourse(course);
    // Load chapters for this course into existing chapters state
    await loadChapters(course.id);
    // Preselect none
    setAttendanceChapterId("");
    setAttendanceSelectedIds([]);
    setShowAttendanceModal(true);
  };

  const toggleAttendanceStudent = (studentId) => {
    setAttendanceSelectedIds((prev) =>
      prev.includes(studentId) ? prev.filter((id) => id !== studentId) : [...prev, studentId]
    );
  };

  const saveAttendance = async () => {
    if (!attendanceCourse || !attendanceChapterId || !selectedClassId) {
      alert("Select a chapter and class first.");
      return;
    }
    setAttendanceSaving(true);
    try {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const key = `class:${selectedClassId}|course:${attendanceCourse.id}|chapter:${attendanceChapterId}|${ymd}`;
      const ref = doc(db, "attendance", key);
      await setDoc(
        ref,
        {
          type: "trainer",
          classId: selectedClassId,
          courseId: attendanceCourse.id,
          chapterId: attendanceChapterId,
          date: ymd,
          present: attendanceSelectedIds,
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );
      setShowAttendanceModal(false);
      setAttendanceCourse(null);
      setAttendanceChapterId("");
      setAttendanceSelectedIds([]);
      alert("Attendance saved.");
    } catch (e) {
      alert(e?.message || "Failed to save attendance");
    } finally {
      setAttendanceSaving(false);
    }
  };

  // Open a 5-minute self-attendance window (students can mark themselves)
  const giveAttendanceWindow = async () => {
    if (!attendanceCourse || !attendanceChapterId || !selectedClassId) {
      alert("Select a chapter and class first.");
      return;
    }
    try {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      await setDoc(doc(collection(db, "attendance")), {
        type: "window",
        classId: selectedClassId,
        courseId: attendanceCourse.id,
        chapterId: attendanceChapterId,
        date: ymd,
        openedAt: serverTimestamp(),
        durationMs: 5 * 60 * 1000,
      });
      alert("Self attendance enabled for 5 minutes for this day.");
      // Keep modal open so trainer can also save later if needed
    } catch (e) {
      alert(e?.message || "Failed to enable self attendance window");
    }
  };

  return (
    <CheckTrainerAuth>
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">Trainer Panel</h1>
        <p className="text-gray-600 mb-4">Pick a class to see its assigned courses and unlock sessions.</p>
        
        {unlockStatus && (
          <div className={`mb-4 p-3 rounded ${unlockStatus.includes('Failed') ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
            {unlockStatus}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white border rounded p-4">
            <h2 className="font-semibold mb-2">Your Classes</h2>
            {allowedClasses.length === 0 ? (
              <p className="text-sm text-gray-500">No class access yet.</p>
            ) : (
              <ul className="space-y-2">
                {allowedClasses.map((id) => {
                  const c = classes.find((x) => x.id === id);
                  const selected = id === selectedClassId;
                  return (
                    <li key={id} className={`flex items-center justify-between border rounded p-2 ${selected ? 'bg-blue-50 border-blue-300' : ''}`}>
                      <button className="text-left flex-1" onClick={() => setSelectedClassId(id)}>
                        {c?.name || id}
                      </button>
                     
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="bg-white border rounded p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">Assigned Courses</h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={unlockStudents}
                  onChange={(e) => setUnlockStudents(e.target.checked)}
                  className="rounded"
                />
                Also unlock for students
              </label>
            </div>
            {!selectedClassId ? (
              <p className="text-sm text-gray-500">Select a class to view its courses.</p>
            ) : classCourses.length === 0 ? (
              <p className="text-sm text-gray-500">No assigned courses.</p>
            ) : (
              <ul className="space-y-2">
                {classCourses.map((cr) => (
                  <li key={cr.id} className="flex items-center justify-between border rounded p-2">
                    <span>{cr.title || cr.id}</span>
                    <div className="flex items-center gap-2">
                      <button 
                        className="text-sm bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded"
                        onClick={() => handleCourseUnlock(cr)}
                        disabled={unlockLoading}
                      >
                        {unlockLoading ? 'Unlocking...' : 'Click to Unlock'}
                      </button>
                      <button
                        className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded"
                        onClick={() => openAttendanceForCourse(cr)}
                      >
                        Take Attendance
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Chapter Selection Modal */}
        {showChapterModal && selectedCourseForUnlock && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
              <h2 className="text-xl font-bold mb-4">
                Select Chapters for {selectedCourseForUnlock.title || selectedCourseForUnlock.id}
              </h2>
              
              {chapters.length > 0 ? (
                <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
                  <div className="flex items-center gap-3 mb-2">
                    <button
                      onClick={() => setSelectedChapters(chapters.map(c => c.id))}
                      className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => setSelectedChapters([])}
                      className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                    >
                      Clear All
                    </button>
                  </div>
                  {chapters.map((ch) => (
                    <label key={ch.id} className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={selectedChapters.includes(ch.id)}
                        onChange={(e) => {
                          setSelectedChapters((prev) => 
                            e.target.checked 
                              ? [...prev, ch.id] 
                              : prev.filter((id) => id !== ch.id)
                          );
                        }}
                        className="rounded"
                      />
                      <span className="flex-1">{ch.title || ch.id}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 mb-4">No chapters found for this course.</p>
              )}

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowChapterModal(false);
                    setSelectedChapters([]);
                    setSelectedCourseForUnlock(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleChapterUnlock}
                  disabled={unlockLoading || selectedChapters.length === 0}
                  className={`px-4 py-2 rounded text-white ${
                    unlockLoading || selectedChapters.length === 0
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-emerald-600 hover:bg-emerald-700'
                  }`}
                >
                  {unlockLoading ? 'Unlocking...' : `Unlock ${selectedChapters.length} Chapter${selectedChapters.length !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Attendance Modal */}
        {showAttendanceModal && attendanceCourse && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-3xl mx-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Take Attendance — {attendanceCourse.title || attendanceCourse.id}</h2>
                <button
                  onClick={() => {
                    setShowAttendanceModal(false);
                    setAttendanceCourse(null);
                    setAttendanceChapterId("");
                    setAttendanceSelectedIds([]);
                  }}
                  className="text-gray-600 hover:text-gray-800"
                >
                  ✕
                </button>
              </div>

              <div className="text-xs text-gray-600 mb-3">
                Today: {(() => {
                  const d = new Date();
                  const y = d.getFullYear();
                  const m = String(d.getMonth() + 1).padStart(2, "0");
                  const day = String(d.getDate()).padStart(2, "0");
                  return `${y}-${m}-${day}`;
                })()}
              </div>

              {/* Select Chapter */}
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Select Chapter (Day)</label>
                <select
                  value={attendanceChapterId}
                  onChange={(e) => setAttendanceChapterId(e.target.value)}
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select chapter...</option>
                  {chapters.map((ch, idx) => (
                    <option key={ch.id} value={ch.id}>
                      Day {idx + 1}: {ch.title || ch.id}
                    </option>
                  ))}
                </select>
              </div>

              {/* Students list */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Students in selected class</h3>
                  <div className="flex items-center gap-2">
                    <button
                      className="text-sm bg-gray-200 px-3 py-1 rounded"
                      onClick={() => {
                        const studentsInClass = classes.length
                          ? students.filter((s) =>
                              Array.isArray(s.classIds) ? s.classIds.includes(selectedClassId) : s.classId === selectedClassId
                            )
                          : [];
                        setAttendanceSelectedIds(studentsInClass.map((s) => s.id));
                      }}
                    >
                      Select All
                    </button>
                    <button
                      className="text-sm bg-gray-200 px-3 py-1 rounded"
                      onClick={() => setAttendanceSelectedIds([])}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="max-h-60 overflow-auto border rounded">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-100">
                        <th className="p-2 text-left">Present</th>
                        <th className="p-2 text-left">Name</th>
                        <th className="p-2 text-left">Email</th>
                        <th className="p-2 text-left">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {students
                        .filter((s) =>
                          Array.isArray(s.classIds) ? s.classIds.includes(selectedClassId) : s.classId === selectedClassId
                        )
                        .map((s) => (
                          <tr key={s.id} className="border-t">
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={attendanceSelectedIds.includes(s.id)}
                                onChange={() => toggleAttendanceStudent(s.id)}
                              />
                            </td>
                            <td className="p-2">{s.name || '-'}</td>
                            <td className="p-2">{s.email || '-'}</td>
                            <td className="p-2">{s.phone || s.phone1 || '-'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => {
                    setShowAttendanceModal(false);
                    setAttendanceCourse(null);
                    setAttendanceChapterId("");
                    setAttendanceSelectedIds([]);
                  }}
                  className="px-4 py-2 border rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={giveAttendanceWindow}
                  disabled={!attendanceChapterId}
                  className={`px-4 py-2 rounded border ${
                    !attendanceChapterId ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white hover:bg-gray-50'
                  }`}
                  title="Open self attendance for 5 minutes (no need to select students)"
                >
                  Give Attendance
                </button>
                <button
                  onClick={saveAttendance}
                  disabled={attendanceSaving || !attendanceChapterId || attendanceSelectedIds.length === 0}
                  className={`px-4 py-2 rounded text-white ${
                    attendanceSaving || !attendanceChapterId || attendanceSelectedIds.length === 0
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  {attendanceSaving ? 'Saving...' : `Save Attendance (${attendanceSelectedIds.length})`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CheckTrainerAuth>
  );
}


