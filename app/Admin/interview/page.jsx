"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import CheckAuth from "../../../lib/CheckAuth";
import { auth, db, firestoreHelpers } from "../../../lib/firebase";
import readXlsxFile from "read-excel-file";

export default function AdminInterviewExamsPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [exams, setExams] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [questionType, setQuestionType] = useState("mcq");
  const [uploading, setUploading] = useState(false);
  const [uploadInfo, setUploadInfo] = useState("");
  const [editingId, setEditingId] = useState(null);

  const mcqList = useMemo(() => questions.filter((q) => q.type === "mcq"), [questions]);
  const descList = useMemo(() => questions.filter((q) => q.type === "descriptive"), [questions]);
  const SCOPE_ALL = "__ALL__";
  const SCOPE_UNASSIGNED = "__UNASSIGNED__";
  const [sections, setSections] = useState([]);
  const [newSectionName, setNewSectionName] = useState("");
  const [activeMcqScope, setActiveMcqScope] = useState(SCOPE_ALL);
  const sectionNames = useMemo(() => {
    const names = new Set(
      (Array.isArray(sections) ? sections : [])
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    );
    for (const q of mcqList) {
      const s = String(q.section || "").trim();
      if (s) names.add(s);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [sections, mcqList]);
  const visibleMcqs = useMemo(() => {
    if (activeMcqScope === SCOPE_ALL) return mcqList;
    if (activeMcqScope === SCOPE_UNASSIGNED)
      return mcqList.filter((q) => !String(q.section || "").trim());
    return mcqList.filter((q) => String(q.section || "").trim() === activeMcqScope);
  }, [mcqList, activeMcqScope]);

  // Results search state
  const [resultPhone, setResultPhone] = useState("");
  const [resultName, setResultName] = useState("");
  const [resultExamId, setResultExamId] = useState("all");
  const [resultsLoading, setResultsLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [resultsInfo, setResultsInfo] = useState("");

  const computeMcqScore = (exam, submission) => {
    let correct = 0;
    let total = 0;
    const qs = Array.isArray(exam?.questions) ? exam.questions : [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      if (!q || q.type !== "mcq") continue;
      total += 1;
      const ans = submission?.answers?.[i];
      const corrArr = Array.isArray(q.correctAnswers) ? q.correctAnswers : [];
      if (corrArr.length > 1) {
        // Multi-select: compare as sets
        const aSet = new Set(Array.isArray(ans) ? ans : []);
        const cSet = new Set(corrArr);
        if (aSet.size === cSet.size && [...aSet].every((x) => cSet.has(x))) {
          correct += 1;
        }
      } else if (corrArr.length === 1) {
        if (ans === corrArr[0]) correct += 1;
      } else if (typeof q.correctAnswer === "number") {
        if (ans === q.correctAnswer) correct += 1;
      }
    }
    const percent = total > 0 ? Math.round((correct / total) * 100) : null;
    return { correct, total, percent };
  };

  const fetchResults = async () => {
    const phoneDigits = String(resultPhone || "").replace(/\D/g, "");
    const nameQuery = String(resultName || "").trim().toLowerCase();
    if (!phoneDigits && !nameQuery) {
      setResultsInfo("Enter phone or name to search.");
      setResults([]);
      return;
    }
    setResultsLoading(true);
    setResultsInfo("");
    try {
      const examsToSearch =
        resultExamId === "all"
          ? exams
          : exams.filter((e) => e.id === resultExamId);

      const aggregated = [];
      for (const ex of examsToSearch) {
        const subCol = firestoreHelpers.collection(db, "interviewExams", ex.id, "submissions");
        let snap;
        if (phoneDigits) {
          const q = firestoreHelpers.query(subCol, firestoreHelpers.where("phone", "==", phoneDigits));
          snap = await firestoreHelpers.getDocs(q);
        } else {
          // name-only search: fetch all submissions for this exam (guard with soft cap)
          snap = await firestoreHelpers.getDocs(subCol);
        }
        snap.docs.forEach((d) => {
          const data = d.data();
          if (nameQuery && !String(data?.name || "").toLowerCase().includes(nameQuery)) return;
          const mcq = computeMcqScore(ex, data);
          aggregated.push({
            id: d.id,
            examId: ex.id,
            examTitle: ex.title,
            name: data?.name || "",
            phone: data?.phone || "",
            submittedAt: data?.submittedAt,
            mcq,
          });
        });
      }
      // Sort newest first
      aggregated.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      setResults(aggregated);
      setResultsInfo(`${aggregated.length} result(s) found.`);
    } catch (e) {
      setResultsInfo("Failed to fetch results. Try again.");
      setResults([]);
    } finally {
      setResultsLoading(false);
    }
  };

  useEffect(() => {
    async function loadExams() {
      try {
        const snap = await firestoreHelpers.getDocs(
          firestoreHelpers.query(
            firestoreHelpers.collection(db, "interviewExams")
          )
        );
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setExams(data);
      } catch (e) {
        // ignore
      }
    }
    loadExams();
  }, []);

  const addMcqQuestion = () => {
    setQuestions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type: "mcq",
        question: "",
        options: ["", "", "", ""],
        correctAnswers: [],
        section: "",
      },
    ]);
  };
  const addMcqToCurrentScope = () => {
    const sectionForNew =
      activeMcqScope === SCOPE_ALL || activeMcqScope === SCOPE_UNASSIGNED
        ? ""
        : activeMcqScope;
    setQuestions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type: "mcq",
        question: "",
        options: ["", "", "", ""],
        correctAnswers: [],
        section: sectionForNew,
      },
    ]);
  };

  const addDescriptiveQuestion = () => {
    setQuestions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        type: "descriptive",
        question: "",
        maxScore: 10,
      },
    ]);
  };

  const updateQuestion = (qid, updater) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === qid ? { ...q, ...updater } : q))
    );
  };

  const removeQuestion = (qid) => {
    setQuestions((prev) => prev.filter((q) => q.id !== qid));
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const cleanQuestions = questions.map((q) => {
        if (q.type === "mcq") {
          return {
            type: "mcq",
            question: String(q.question || "").trim(),
            options: Array.isArray(q.options)
              ? q.options.map((o) => String(o || ""))
              : ["", "", "", ""],
            correctAnswers: Array.isArray(q.correctAnswers)
              ? q.correctAnswers
              : [],
            section: String(q.section || "").trim(),
          };
        }
        return {
          type: "descriptive",
          question: String(q.question || "").trim(),
          maxScore: Number.isFinite(Number(q.maxScore)) ? Number(q.maxScore) : 10,
        };
      });
      const base = {
        title: String(title || "").trim(),
        description: String(description || "").trim(),
        durationMinutes: Number.isFinite(Number(durationMinutes))
          ? Number(durationMinutes)
          : 60,
        questions: cleanQuestions,
        sections: sectionNames,
      };

      if (editingId) {
        // Update existing
        await firestoreHelpers.updateDoc(
          firestoreHelpers.doc(db, "interviewExams", editingId),
          { ...base, updatedAt: Date.now() }
        );
        setExams((prev) =>
          prev.map((ex) => (ex.id === editingId ? { ...ex, ...base, updatedAt: Date.now() } : ex))
        );
        alert("Interview exam updated.");
      } else {
        // Create new
        const payload = {
          ...base,
          createdAt: Date.now(),
          createdBy: auth.currentUser?.uid || null,
        };
        const ref = await firestoreHelpers.addDoc(
          firestoreHelpers.collection(db, "interviewExams"),
          payload
        );
        setExams((prev) => [{ id: ref.id, ...payload }, ...prev]);
        alert("Interview exam created.");
      }

      // Reset form
      setTitle("");
      setDescription("");
      setDurationMinutes(60);
      setQuestions([]);
      setEditingId(null);
      setSections([]);
      setNewSectionName("");
      setActiveMcqScope(SCOPE_ALL);
    } catch (e) {
      setError("Failed to save exam. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (exam) => {
    setEditingId(exam.id);
    setTitle(exam.title || "");
    setDescription(exam.description || "");
    setDurationMinutes(Number.isFinite(Number(exam.durationMinutes)) ? Number(exam.durationMinutes) : 60);
    const safe = Array.isArray(exam.questions)
      ? exam.questions.map((q) => ({
          id: crypto.randomUUID(),
          type: q?.type === "descriptive" ? "descriptive" : "mcq",
          question: String(q?.question || ""),
          options:
            q?.type === "mcq"
              ? (Array.isArray(q?.options) ? q.options : ["", "", "", ""]).map((o) => String(o || ""))
              : undefined,
          correctAnswers:
            q?.type === "mcq"
              ? (Array.isArray(q?.correctAnswers) ? q.correctAnswers : [])
              : undefined,
          section: q?.type === "mcq" ? String(q?.section || "") : undefined,
          maxScore: q?.type === "descriptive" ? (Number.isFinite(Number(q?.maxScore)) ? Number(q.maxScore) : 10) : undefined,
        }))
      : [];
    setQuestions(safe);
    const incomingSections =
      Array.isArray(exam.sections) && exam.sections.length > 0
        ? exam.sections.map((s) => String(s || "").trim()).filter(Boolean)
        : Array.from(
            new Set(
              safe
                .filter((q) => q.type === "mcq")
                .map((q) => String(q.section || "").trim())
                .filter(Boolean)
            )
          );
    setSections(incomingSections);
    setActiveMcqScope(SCOPE_ALL);
    window?.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setTitle("");
    setDescription("");
    setDurationMinutes(60);
    setQuestions([]);
    setSections([]);
    setNewSectionName("");
    setActiveMcqScope(SCOPE_ALL);
  };

  const handleDelete = async (examId) => {
    if (!confirm("Delete this exam? This will also remove its submissions.")) return;
    try {
      // Delete submissions
      const subsSnap = await firestoreHelpers.getDocs(
        firestoreHelpers.collection(db, "interviewExams", examId, "submissions")
      );
      await Promise.all(
        subsSnap.docs.map((d) =>
          firestoreHelpers.deleteDoc(
            firestoreHelpers.doc(db, "interviewExams", examId, "submissions", d.id)
          )
        )
      );
      // Delete exam
      await firestoreHelpers.deleteDoc(firestoreHelpers.doc(db, "interviewExams", examId));
      setExams((prev) => prev.filter((e) => e.id !== examId));
      if (editingId === examId) cancelEdit();
      alert("Exam deleted.");
    } catch (e) {
      alert("Failed to delete exam. Please try again.");
    }
  };

  return (
    <CheckAuth>
      <div className="min-h-screen bg-gradient-to-b from-sky-50 to-cyan-50 p-4 sm:p-6">
        <div className="max-w-5xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Interview Exams</h1>
            <p className="text-gray-600">Create and manage interview-style exams (MCQ + Descriptive).</p>
          </div>

          <div className="bg-white rounded-xl shadow p-4 sm:p-6 mb-8">
            <h2 className="text-lg font-semibold mb-4">Create New Exam</h2>
            {editingId && (
              <div className="mb-4 p-3 rounded-lg border border-amber-300 bg-amber-50 flex items-center justify-between">
                <span className="text-sm text-amber-800">Editing exam...</span>
                <button onClick={cancelEdit} className="px-3 py-1.5 text-sm rounded border border-amber-400 text-amber-800 hover:bg-amber-100">
                  Cancel
                </button>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <input
                type="text"
                placeholder="Exam Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-cyan-500"
              />
              <input
                type="number"
                min={1}
                placeholder="Duration (minutes)"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-cyan-500"
              />
            </div>
            <textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 mt-4 focus:ring-2 focus:ring-cyan-500"
            />

            {/* Excel Upload for MCQs */}
            <div className="mt-6 border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="font-medium text-gray-800">Bulk add MCQs from Excel</p>
                  <p className="text-xs text-gray-600">
                    Accepted headers (case-insensitive): <strong>Question No. (optional), Question, Option A, Option B, Option C, Option D, Correct Answer, Section (optional)</strong>.
                    Also supported: <strong>option1..4</strong> and <strong>correct</strong>. The <strong>Correct Answer</strong> can be numbers (1-4) or letters (A-D), comma-separated for multiple answers. Use <strong>Section</strong> to group MCQs.
                  </p>
                </div>
                {uploadInfo && <span className="text-xs text-cyan-700">{uploadInfo}</span>}
              </div>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  setUploadInfo("");
                  try {
                    const rows = await readXlsxFile(file);
                    // Expect header row
                    if (!rows || rows.length === 0) {
                      setUploadInfo("No rows found in file.");
                      setUploading(false);
                      return;
                    }
                    const header = rows[0].map((h) => String(h || "").toLowerCase().trim());
                    const colIndex = (nameVariants) => {
                      for (const v of nameVariants) {
                        const idx = header.indexOf(v);
                        if (idx !== -1) return idx;
                      }
                      return -1;
                    };
                    const idxQ = colIndex(["question", "questions", "title"]);
                    const idx1 = colIndex(["option1", "opt1", "a", "option a"]);
                    const idx2 = colIndex(["option2", "opt2", "b", "option b"]);
                    const idx3 = colIndex(["option3", "opt3", "c", "option c"]);
                    const idx4 = colIndex(["option4", "opt4", "d", "option d"]);
                    const idxC = colIndex(["correct answer", "correct", "answer", "answers", "right answer"]);
                    const idxS = colIndex(["section", "topic", "category"]);

                    const mapCorrect = (cell) => {
                      if (cell == null) return [];
                      const raw = String(cell).trim();
                      if (!raw) return [];
                      return raw
                        .split(/[,\s]+/)
                        .map((t) => t.trim())
                        .filter(Boolean)
                        .map((t) => {
                          const upper = t.toUpperCase();
                          if (upper === "A") return 0;
                          if (upper === "B") return 1;
                          if (upper === "C") return 2;
                          if (upper === "D") return 3;
                          const n = Number(t);
                          if (Number.isFinite(n)) return Math.max(0, Math.min(3, n - 1));
                          return null;
                        })
                        .filter((v) => v != null);
                    };

                    const imported = [];
                    for (let r = 1; r < rows.length; r++) {
                      const row = rows[r] || [];
                      const q = idxQ >= 0 ? row[idxQ] : null;
                      const o1 = idx1 >= 0 ? row[idx1] : "";
                      const o2 = idx2 >= 0 ? row[idx2] : "";
                      const o3 = idx3 >= 0 ? row[idx3] : "";
                      const o4 = idx4 >= 0 ? row[idx4] : "";
                      const corr = idxC >= 0 ? row[idxC] : "";
                      let sec = idxS >= 0 ? row[idxS] : "";
                      if (!(idxS >= 0)) {
                        // Default to active scope when no Section column provided
                        sec =
                          activeMcqScope === SCOPE_ALL || activeMcqScope === SCOPE_UNASSIGNED
                            ? ""
                            : activeMcqScope;
                      }
                      const questionText = String(q || "").trim();
                      if (!questionText) continue;
                      imported.push({
                        id: crypto.randomUUID(),
                        type: "mcq",
                        question: questionText,
                        options: [o1, o2, o3, o4].map((x) => String(x ?? "")),
                        correctAnswers: Array.from(new Set(mapCorrect(corr))),
                        section: String(sec || "").trim(),
                      });
                    }

                    if (imported.length === 0) {
                      setUploadInfo("No valid MCQs detected in the file.");
                    } else {
                      setQuestions((prev) => [...prev, ...imported]);
                      setUploadInfo(`Imported ${imported.length} MCQs.`);
                    }
                  } catch (err) {
                    setUploadInfo("Failed to read the Excel file.");
                  } finally {
                    setUploading(false);
                    // Reset input so user can re-upload same file if needed
                    e.target.value = "";
                  }
                }}
                className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-cyan-600 file:px-4 file:py-2 file:text-white hover:file:bg-cyan-700"
                disabled={uploading}
              />
            </div>

            <div className="mt-6">
              <div className="flex items-center gap-3 mb-4">
                <select
                  value={questionType}
                  onChange={(e) => setQuestionType(e.target.value)}
                  className="border rounded-lg px-3 py-2"
                >
                  <option value="mcq">MCQ</option>
                  <option value="descriptive">Descriptive</option>
                </select>
                <button
                  onClick={() => (questionType === "mcq" ? addMcqToCurrentScope() : addDescriptiveQuestion())}
                  className="px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700"
                >
                  Add Question
                </button>
              </div>
              {/* Section manager and scope tabs for MCQs */}
              <div className="mb-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveMcqScope(SCOPE_ALL)}
                    className={`px-3 py-1.5 text-xs rounded-full border ${activeMcqScope === SCOPE_ALL ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
                  >
                    All MCQs
                  </button>
                  {sectionNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setActiveMcqScope(name)}
                      className={`px-3 py-1.5 text-xs rounded-full border ${activeMcqScope === name ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
                      title={`View MCQs in ${name}`}
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setActiveMcqScope(SCOPE_UNASSIGNED)}
                    className={`px-3 py-1.5 text-xs rounded-full border ${activeMcqScope === SCOPE_UNASSIGNED ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
                    title="View MCQs with no section"
                  >
                    Unassigned
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="New section name"
                    className="border rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const n = String(newSectionName || "").trim();
                      if (!n) return;
                      setSections((prev) => Array.from(new Set([...(prev || []), n])));
                      setNewSectionName("");
                      setActiveMcqScope(n);
                    }}
                    className="px-3 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-900"
                  >
                    Add Section
                  </button>
                </div>
              </div>

              {/* MCQ Section */}
              {mcqList.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-gray-900">
                      {activeMcqScope === SCOPE_ALL
                        ? "MCQ Questions (All)"
                        : activeMcqScope === SCOPE_UNASSIGNED
                        ? "MCQ Questions (Unassigned)"
                        : `MCQ Questions (${activeMcqScope})`}
                    </h3>
                    <span className="text-xs text-gray-600">{visibleMcqs.length} item(s)</span>
                  </div>
                  <div className="space-y-4">
                    {visibleMcqs.map((q, idx) => (
                      <div key={q.id} className="border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-medium text-gray-700">
                            {idx + 1}. MCQ
                          </span>
                          <div className="flex items-center gap-3">
                            <select
                              value={String(q.section || "").trim()}
                              onChange={(e) => updateQuestion(q.id, { section: e.target.value })}
                              className="text-xs border rounded px-2 py-1"
                              title="Change section"
                            >
                              <option value="">Unassigned</option>
                              {sectionNames.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => removeQuestion(q.id)}
                              className="text-red-600 hover:text-red-700 text-sm"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          placeholder="Question"
                          value={q.question || ""}
                          onChange={(e) => updateQuestion(q.id, { question: e.target.value })}
                          className="w-full border rounded-lg px-3 py-2 mb-3"
                        />
                        <div className="grid sm:grid-cols-2 gap-3">
                          {(q.options || []).map((opt, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) => {
                                  const newOptions = [...(q.options || ["", "", "", ""])];
                                  newOptions[i] = e.target.value;
                                  updateQuestion(q.id, { options: newOptions });
                                }}
                                placeholder={`Option ${i + 1}`}
                                className="flex-1 border rounded-lg px-3 py-2"
                              />
                              <input
                                type="checkbox"
                                checked={Array.isArray(q.correctAnswers) && q.correctAnswers.includes(i)}
                                onChange={(e) => {
                                  const prev = Array.isArray(q.correctAnswers) ? q.correctAnswers : [];
                                  const next = e.target.checked
                                    ? Array.from(new Set([...prev, i]))
                                    : prev.filter((x) => x !== i);
                                  updateQuestion(q.id, { correctAnswers: next });
                                }}
                                className="w-4 h-4"
                                title="Mark as correct"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Descriptive Section */}
              {descList.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-gray-900">Descriptive Questions</h3>
                    <span className="text-xs text-gray-600">{descList.length} item(s)</span>
                  </div>
                  <div className="space-y-4">
                    {descList.map((q, idx) => (
                      <div key={q.id} className="border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-medium text-gray-700">
                            {idx + 1}. Descriptive
                          </span>
                          <button
                            onClick={() => removeQuestion(q.id)}
                            className="text-red-600 hover:text-red-700 text-sm"
                          >
                            Remove
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Question"
                          value={q.question || ""}
                          onChange={(e) => updateQuestion(q.id, { question: e.target.value })}
                          className="w-full border rounded-lg px-3 py-2 mb-3"
                        />
                        <div className="flex items-center gap-3">
                          <label className="text-sm text-gray-700">Max Score</label>
                          <input
                            type="number"
                            min={1}
                            value={q.maxScore || 10}
                            onChange={(e) => updateQuestion(q.id, { maxScore: e.target.value })}
                            className="w-24 border rounded-lg px-3 py-2"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Fallback when no questions */}
              {questions.length === 0 && (
                <div className="border rounded-lg p-4">
                  <p className="text-sm text-gray-600">No questions added yet. Choose a type above and click “Add Question”.</p>
                </div>
              )}
            </div>

            {error && <p className="text-red-600 mt-4 text-sm">{error}</p>}
            <div className="mt-6">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 bg-[#00448a] hover:bg-[#003a76] text-white rounded-lg disabled:opacity-60"
              >
                {saving ? (editingId ? "Updating..." : "Saving...") : editingId ? "Update Exam" : "Save Exam"}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow p-4 sm:p-6">
            <h2 className="text-lg font-semibold mb-4">Existing Exams</h2>
            {exams.length === 0 ? (
              <p className="text-gray-600 text-sm">No interview exams yet.</p>
            ) : (
              <div className="divide-y">
                {exams.map((ex) => (
                  <div key={ex.id} className="py-3 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-gray-900">{ex.title}</p>
                      <p className="text-xs text-gray-600">
                        {ex.questions?.length || 0} questions • {ex.durationMinutes} min
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => startEdit(ex)}
                        className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
                        title="Edit"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => router.push(`/interview/${ex.id}`)}
                        className="px-3 py-1.5 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded"
                        title="Open as Test"
                      >
                        View
                      </button>
                      <button
                        onClick={() => handleDelete(ex.id)}
                        className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded"
                        title="Delete"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Results Search */}
          <div className="bg-white rounded-xl shadow p-4 sm:p-6 mt-6">
            <h2 className="text-lg font-semibold mb-4">Search Results (by Name/Phone)</h2>
            <div className="grid sm:grid-cols-4 gap-3 mb-3">
              <select
                value={resultExamId}
                onChange={(e) => setResultExamId(e.target.value)}
                className="border rounded-lg px-3 py-2"
              >
                <option value="all">All Exams</option>
                {exams.map((ex) => (
                  <option key={ex.id} value={ex.id}>{ex.title}</option>
                ))}
              </select>
              <input
                type="tel"
                value={resultPhone}
                onChange={(e) => setResultPhone(e.target.value)}
                placeholder="Phone Number"
                className="border rounded-lg px-3 py-2"
              />
              <input
                type="text"
                value={resultName}
                onChange={(e) => setResultName(e.target.value)}
                placeholder="Name (optional)"
                className="border rounded-lg px-3 py-2"
              />
              <button
                onClick={fetchResults}
                disabled={resultsLoading}
                className="px-4 py-2 bg-[#00448a] hover:bg-[#003a76] text-white rounded-lg disabled:opacity-60"
              >
                {resultsLoading ? "Searching..." : "Search"}
              </button>
            </div>
            {resultsInfo && <p className="text-xs text-gray-600 mb-3">{resultsInfo}</p>}

            {results.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-700 border-b">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Exam</th>
                      <th className="py-2 pr-4">Name</th>
                      <th className="py-2 pr-4">Phone</th>
                      <th className="py-2 pr-4">MCQ Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const date =
                        typeof r.submittedAt === "number"
                          ? new Date(r.submittedAt).toLocaleString()
                          : r.submittedAt?.toDate?.()?.toLocaleString?.() || "—";
                      const score =
                        r.mcq?.percent != null
                          ? `${r.mcq.percent}% (${r.mcq.correct}/${r.mcq.total})`
                          : "—";
                      return (
                        <tr key={`${r.examId}-${r.id}`} className="border-b hover:bg-gray-50">
                          <td className="py-2 pr-4 whitespace-nowrap">{date}</td>
                          <td className="py-2 pr-4">{r.examTitle}</td>
                          <td className="py-2 pr-4">{r.name}</td>
                          <td className="py-2 pr-4">{r.phone}</td>
                          <td className="py-2 pr-4">{score}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-600">No results to display.</p>
            )}
          </div>
        </div>
      </div>
    </CheckAuth>
  );
}


