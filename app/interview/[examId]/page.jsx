"use client";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { db, firestoreHelpers } from "../../../lib/firebase";

export default function TakeInterviewExamPage() {
  const router = useRouter();
  const { examId } = useParams();
  const [exam, setExam] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [answers, setAnswers] = useState({});
  const [timeLeftMs, setTimeLeftMs] = useState(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [reviewMap, setReviewMap] = useState({});
  const [showPanel, setShowPanel] = useState(false);
  const [section, setSection] = useState("mcq"); // mcq | descriptive
  const [started, setStarted] = useState(false);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    async function load() {
      try {
        const ref = firestoreHelpers.doc(db, "interviewExams", String(examId));
        const snap = await firestoreHelpers.getDoc(ref);
        if (snap.exists()) {
          const data = snap.data();
          setExam({ id: snap.id, ...data });
          // Choose default section based on available questions
          const hasMcq = (data.questions || []).some((q) => q?.type === "mcq");
          const hasDesc = (data.questions || []).some((q) => q?.type === "descriptive");
          if (!hasMcq && hasDesc) setSection("descriptive");
          if (hasMcq && !hasDesc) setSection("mcq");
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [examId]);

  const formatTime = (ms) => {
    if (ms == null) return null;
    const total = Math.floor(ms / 1000);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(m)}:${pad(s)}`;
  };

  const handleMcq = (qIndex, optionIndex, multiple) => {
    setAnswers((prev) => {
      if (multiple) {
        const cur = Array.isArray(prev[qIndex]) ? prev[qIndex] : [];
        const next = cur.includes(optionIndex)
          ? cur.filter((i) => i !== optionIndex)
          : [...cur, optionIndex];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: optionIndex };
    });
  };

  const handleText = (qIndex, value) => {
    setAnswers((prev) => ({ ...prev, [qIndex]: value }));
  };

  const progress = useMemo(() => {
    const total = exam?.questions?.length || 0;
    if (total === 0) return { answered: 0, total, percent: 0 };
    let answered = 0;
    for (let i = 0; i < total; i++) {
      const a = answers[i];
      if (Array.isArray(a)) {
        if (a.length > 0) answered += 1;
      } else if (a !== undefined && a !== null && String(a).trim() !== "") {
        answered += 1;
      }
    }
    return { answered, total, percent: Math.round((answered / total) * 100) };
  }, [answers, exam]);

  const isAnswered = useCallback((index) => {
    const a = answers[index];
    if (Array.isArray(a)) return a.length > 0;
    return a !== undefined && a !== null && String(a).trim() !== "";
  }, [answers]);

  const toggleReview = useCallback((idx) => {
    setReviewMap((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const mcqIndices = useMemo(() => {
    return (exam?.questions || []).map((q, i) => ({ q, i })).filter(({ q }) => q?.type === "mcq").map(({ i }) => i);
  }, [exam]);
  const descIndices = useMemo(() => {
    return (exam?.questions || []).map((q, i) => ({ q, i })).filter(({ q }) => q?.type === "descriptive").map(({ i }) => i);
  }, [exam]);
  const filteredIndices = useMemo(() => {
    return section === "mcq" ? mcqIndices : descIndices;
  }, [section, mcqIndices, descIndices]);

  useEffect(() => {
    if (!filteredIndices.includes(activeIndex) && filteredIndices.length > 0) {
      setActiveIndex(filteredIndices[0]);
    }
  }, [section, filteredIndices, activeIndex]);

  const totalInSection = filteredIndices.length;
  const currentPos = filteredIndices.indexOf(activeIndex);

  const startExam = () => {
    // Validate before starting
    const phoneDigits = phone.replace(/\D/g, "");
    if (!fullName.trim()) {
      alert("Please enter your name.");
      return;
    }
    if (phoneDigits.length < 10) {
      alert("Please enter a valid phone number (10+ digits).");
      return;
    }
    if (!acceptedRules) {
      alert("Please accept the rules to proceed.");
      return;
    }
    setStarted(true);
    // Start timer
    const duration = Number(exam?.durationMinutes) || 0;
    if (duration > 0) {
      const endAt = Date.now() + duration * 60 * 1000;
      setTimeLeftMs(endAt - Date.now());
      timerRef.current = setInterval(() => {
        setTimeLeftMs((prev) => {
          const next = Math.max(0, (prev ?? endAt - Date.now()) - 1000);
          if (next <= 0) {
            clearInterval(timerRef.current);
          }
          return next;
        });
      }, 1000);
    }
  };

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleSubmit = async () => {
    // Basic validation
    if (!fullName.trim()) {
      alert("Please enter your name.");
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      alert("Please enter a valid phone number (10+ digits).");
      return;
    }
    setSubmitting(true);
    try {
      // Prevent duplicate submissions per phone number
      const subCol = firestoreHelpers.collection(db, "interviewExams", String(examId), "submissions");
      const q = firestoreHelpers.query(subCol, firestoreHelpers.where("phone", "==", phoneDigits));
      const existing = await firestoreHelpers.getDocs(q);
      if (!existing.empty) {
        alert("A submission has already been received for this phone number.");
        setSubmitting(false);
        return;
      }
      const payload = {
        name: fullName.trim(),
        phone: phoneDigits,
        submittedAt: Date.now(),
        answers,
      };
      await firestoreHelpers.addDoc(subCol, payload);
      alert("Submission received.");
      router.push("/interview");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  if (!exam) {
    return <div className="min-h-screen flex items-center justify-center">Exam not found.</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-cyan-50">
      {/* Sticky Header */}
      <div className="sticky top-0 z-20 border-b bg-white/80 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{exam.title}</h1>
            {exam.description && <p className="text-xs sm:text-sm text-gray-600">{exam.description}</p>}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-sm text-gray-700">{progress.answered}/{progress.total} answered</div>
            <div className="w-28 sm:w-44">
              <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-cyan-600" style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
            {timeLeftMs != null && (
              <span className="px-3 py-1 rounded-md bg-black text-white text-xs sm:text-sm font-medium">
                {formatTime(timeLeftMs)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6">

        {/* Pre-Exam Info (visible until started) */}
        {!started && (
          <div className="bg-white rounded-xl shadow p-4 sm:p-6 mb-6">
            <h2 className="text-base sm:text-lg font-semibold mb-3 text-gray-900">Candidate Details</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <input
                type="text"
                placeholder="Full Name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-cyan-500"
              />
              <input
                type="tel"
                placeholder="Phone Number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 focus:ring-2 focus:ring-cyan-500"
              />
            </div>
            <div className="mt-6">
              <h3 className="font-semibold text-gray-900 mb-2">Rules & Exam Pattern</h3>
              <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
                <li>Time Limit: {Number(exam?.durationMinutes) || 0} minutes.</li>
                <li>Total Questions: {exam?.questions?.length || 0} (MCQ: {mcqIndices.length}, Descriptive: {descIndices.length}).</li>
                <li>Only one submission is allowed. After submission, edits or resubmissions will be not be allowed.</li>
                <li>You can navigate between questions and mark them for review.</li>
                <li>Do not refresh or close the tab during the exam.</li>
              </ul>
              <label className="mt-3 flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={acceptedRules}
                  onChange={(e) => setAcceptedRules(e.target.checked)}
                  className="w-4 h-4 text-cyan-600"
                />
                I have read and agree to the rules above.
              </label>
              <div className="mt-4">
                <button
                  type="button"
                  onClick={startExam}
                  className="px-5 py-2 bg-[#00448a] hover:bg-[#003a76] text-white rounded-lg disabled:opacity-60"
                >
                  Proceed to Test
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Section Selector (only after start) */}
        {started && (
          <div className="bg-white rounded-xl shadow p-3 sm:p-4 mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-700 mr-2">Sections:</span>
              <button
                type="button"
                onClick={() => setSection("mcq")}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  section === "mcq" ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                }`}
              >
                MCQ ({mcqIndices.length})
              </button>
              <button
                type="button"
                onClick={() => setSection("descriptive")}
                className={`px-3 py-1.5 rounded-full text-sm border ${
                  section === "descriptive" ? "bg-cyan-600 text-white border-cyan-600" : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                }`}
              >
                Descriptive ({descIndices.length})
              </button>
            </div>
          </div>
        )}

        {/* Question Area */}
        {started && (
          <div className="bg-white rounded-xl shadow p-4 sm:p-6">
          {(() => {
            if (totalInSection === 0) {
              return (
                <div className="text-center py-10">
                  <p className="text-gray-600">
                    No questions in this section.
                  </p>
                </div>
              );
            }
            const q = (exam.questions || [])[activeIndex];
            if (!q) return null;
            const multiple = Array.isArray(q.correctAnswers) && q.correctAnswers.length > 1;
            return (
              <div className="">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <p className="font-semibold text-gray-900 text-base sm:text-lg">
                    Question {currentPos + 1} of {totalInSection}
                  </p>
                </div>
                <p className="text-gray-800 mb-4">{q.question}</p>
                {q.type === "mcq" ? (
                  <div className="grid sm:grid-cols-2 gap-3">
                    {(q.options || []).map((opt, oIndex) => {
                      const selected = multiple
                        ? Array.isArray(answers[activeIndex]) && answers[activeIndex].includes(oIndex)
                        : answers[activeIndex] === oIndex;
                      return (
                        <button
                          key={oIndex}
                          type="button"
                          onClick={() => handleMcq(activeIndex, oIndex, multiple)}
                          className={`text-left px-3 py-2 rounded-lg border transition ${
                            selected
                              ? "border-cyan-600 bg-cyan-50 text-cyan-900"
                              : "border-gray-300 hover:border-cyan-300 hover:bg-gray-50"
                          }`}
                        >
                          <span className="font-medium mr-2">{String.fromCharCode(65 + oIndex)}.</span>
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    value={answers[activeIndex] || ""}
                    onChange={(e) => handleText(activeIndex, e.target.value)}
                    placeholder="Write your answer..."
                    className="w-full border rounded-lg px-3 py-2 min-h-[140px] focus:ring-2 focus:ring-cyan-500"
                  />
                )}

                {/* Navigation */}
                <div className="mt-6 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => {
                      const prevPos = Math.max(0, currentPos - 1);
                      setActiveIndex(filteredIndices[prevPos]);
                    }}
                    disabled={currentPos <= 0}
                    className={`px-4 py-2 rounded-lg border ${
                      currentPos <= 0
                        ? "bg-gray-100 text-gray-400 border-gray-200"
                        : "bg-white text-gray-800 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    Previous
                  </button>

                  <div className="hidden sm:flex items-center gap-1">
                    {filteredIndices.map((qi, i) => (
                      <button
                        key={i}
                        aria-label={`Go to question ${i + 1} in section`}
                        onClick={() => setActiveIndex(qi)}
                        className={`h-2.5 w-2.5 rounded-full ${
                          i === currentPos ? "bg-cyan-600" : "bg-gray-300 hover:bg-gray-400"
                        }`}
                      />
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const nextPos = Math.min(totalInSection - 1, currentPos + 1);
                      setActiveIndex(filteredIndices[nextPos]);
                    }}
                    disabled={currentPos >= totalInSection - 1}
                    className={`px-4 py-2 rounded-lg border ${
                      currentPos >= totalInSection - 1
                        ? "bg-gray-100 text-gray-400 border-gray-200"
                        : "bg-cyan-600 text-white border-cyan-600 hover:bg-cyan-700"
                    }`}
                  >
                    Next
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => toggleReview(activeIndex)}
                    className={`px-3 py-1.5 rounded-md text-sm border ${
                      reviewMap[activeIndex]
                        ? "bg-purple-600 text-white border-purple-600"
                        : "bg-white text-purple-700 border-purple-300 hover:bg-purple-50"
                    }`}
                  >
                    {reviewMap[activeIndex] ? "Unmark Review" : "Mark for Review"}
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowPanel(true)}
                    className="sm:hidden px-3 py-1.5 rounded-md text-sm bg-gray-100 border border-gray-300"
                  >
                    Questions
                  </button>
                </div>
              </div>
            );
          })()}
          </div>
        )}

        {/* Submit Bar */}
        {started && (
          <div className="mt-6 flex items-center justify-between">
          <div className="text-sm text-gray-700">
            Progress: <span className="font-semibold">{progress.percent}%</span> ({progress.answered}/{progress.total})
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-5 py-2 bg-[#00448a] hover:bg-[#003a76] text-white rounded-lg disabled:opacity-60"
          >
            {submitting ? "Submitting..." : "Submit Answers"}
          </button>
          </div>
        )}
      </div>

      {/* Desktop Control Panel */}
      {started && (
        <div className="hidden lg:block fixed right-4 top-34 z-10">
        <div className="bg-white rounded-xl shadow border p-4 w-64">
          <div className="flex items-center justify-between mb-3">
            <p className="font-semibold text-gray-900">Question Panel</p>
            <span className="text-xs text-gray-600">{progress.answered}/{progress.total}</span>
          </div>
          <div className="grid grid-cols-6 gap-2">
            {filteredIndices.map((qi, i) => {
              const current = qi === activeIndex;
              const answered = isAnswered(qi);
              const marked = reviewMap[qi];
              let cls = "bg-gray-200 text-gray-800";
              if (answered) cls = "bg-green-600 text-white";
              if (marked) cls = "bg-purple-600 text-white";
              if (current) cls = "bg-cyan-600 text-white";
              return (
                <button
                  key={i}
                  onClick={() => setActiveIndex(qi)}
                  className={`h-8 rounded-md text-xs font-semibold ${cls}`}
                  title={`Question ${qi + 1}`}
                >
                  {qi + 1}
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-700">
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-cyan-600 inline-block" />Current</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-green-600 inline-block" />Answered</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-gray-300 inline-block" />Not Answered</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-purple-600 inline-block" />Marked</div>
          </div>
        </div>
        </div>
      )}

      {/* Mobile Bottom Sheet Panel */}
      {started && showPanel && (
        <div className="lg:hidden fixed inset-0 z-30">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowPanel(false)} />
          <div className="absolute left-0 right-0 bottom-0 bg-white rounded-t-2xl shadow-2xl p-4 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="font-semibold text-gray-900">Question Panel</p>
              <button
                className="px-3 py-1.5 rounded-md border text-sm"
                onClick={() => setShowPanel(false)}
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-6 gap-2">
              {filteredIndices.map((qi, i) => {
                const current = qi === activeIndex;
                const answered = isAnswered(qi);
                const marked = reviewMap[qi];
                let cls = "bg-gray-200 text-gray-800";
                if (answered) cls = "bg-green-600 text-white";
                if (marked) cls = "bg-purple-600 text-white";
                if (current) cls = "bg-cyan-600 text-white";
                return (
                  <button
                    key={i}
                    onClick={() => { setActiveIndex(qi); setShowPanel(false); }}
                    className={`h-9 rounded-md text-xs font-semibold ${cls}`}
                  >
                    {qi + 1}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


