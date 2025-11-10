"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, deleteDoc, doc, updateDoc, getDoc } from "firebase/firestore";
import { db, auth } from "@/lib/firebase";
import { onAuthStateChanged } from "firebase/auth";
import CheckAdminAuth from "@/lib/CheckAdminAuth";
import { useRouter } from "next/navigation";
import { CreditCard, DollarSign, CheckCircle, AlertCircle, MessageCircle } from "lucide-react";
import { makeAuthenticatedRequest, handleAuthError } from "@/lib/authUtils";

export default function StudentListPage() {
      const router = useRouter();
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [phoneQuery, setPhoneQuery] = useState("");
  const [lockFilter, setLockFilter] = useState("all"); // "all", "locked", "unlocked"
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState("online"); // "online" or "cash"
  const [showCashSuccess, setShowCashSuccess] = useState(false);
  const [waSendingId, setWaSendingId] = useState(null);
  const [currentUserRole, setCurrentUserRole] = useState("");
  const [showEditFeeModal, setShowEditFeeModal] = useState(false);
  const [editFeeStudent, setEditFeeStudent] = useState(null);
  const [newTotalFee, setNewTotalFee] = useState("");

  // Enhanced error handling for authentication
  const handleAuthExpired = () => {
    alert('Your session has expired. Please log in again.');
    router.push('/auth/login');
  };

  useEffect(() => {
    fetchStudents();
  }, []);

  // Fetch current user role
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const userDocRef = doc(db, "users", user.uid);
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            const userData = userDoc.data();
            setCurrentUserRole(userData.role || "");
          }
        } catch (error) {
          console.error("Error fetching user role:", error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Prevent navigation during payment processing
  useEffect(() => {
    if (isProcessingPayment) {
      const handleBeforeUnload = (e) => {
        e.preventDefault();
        e.returnValue = "Payment is being processed. Please wait...";
        return "Payment is being processed. Please wait...";
      };

      const handlePopState = (e) => {
        e.preventDefault();
        alert("Please wait for payment processing to complete.");
        window.history.pushState(null, "", window.location.href);
      };

      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("popstate", handleBeforeUnload);
      window.history.pushState(null, "", window.location.href);

      return () => {
        window.removeEventListener("beforeunload", handleBeforeUnload);
        window.removeEventListener("popstate", handleBeforeUnload);
      };
    }
  }, [isProcessingPayment]);

  async function fetchStudents() {
    setLoading(true);
    const snap = await getDocs(collection(db, "students"));
    setStudents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }

  async function handleDeleteStudent(id) {
    const confirmed = confirm(
      "Delete this student from the system? This will also remove their login access."
    );
    if (!confirmed) return;

    try {
      const res = await makeAuthenticatedRequest("/api/delete-student", {
        method: "POST",
        body: JSON.stringify({ id }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete student");
      }

      await fetchStudents();
      alert("Student deleted successfully.");
    } catch (e) {
      console.error("Delete student failed:", e);
      
      // Check for DECODER error specifically
      if (e.message?.includes('DECODER') || e.message?.includes('OpenSSL')) {
        alert("Authentication error: OpenSSL compatibility issue detected. This is a known issue on Windows. Please try again or contact administrator if the problem persists.");
      } else {
        handleAuthError(e, handleAuthExpired);
        alert(e.message || "Failed to delete student");
      }
    }
  }

  function openEditFeeModal(student) {
    setEditFeeStudent(student);
    setNewTotalFee(student.totalFee || "");
    setShowEditFeeModal(true);
  }

  function closeEditFeeModal() {
    setShowEditFeeModal(false);
    setEditFeeStudent(null);
    setNewTotalFee("");
  }

  async function handleUpdateTotalFee() {
    if (!editFeeStudent) return;

    const amount = Number(newTotalFee);
    if (isNaN(amount) || amount < 0) {
      alert("Please enter a valid total fee amount.");
      return;
    }

    try {
      await updateDoc(doc(db, "students", editFeeStudent.id), { totalFee: amount });
      await fetchStudents();
      closeEditFeeModal();
      alert("Total fee updated successfully!");
    } catch (e) {
      console.error("Failed to update total fee:", e);
      alert(e?.message || "Failed to update total fee");
    }
  }

  async function handleSendWhatsappTemplate(student) {
    try {
      const phone = student.phone1 || student.phone;
      if (!phone) {
        alert("Student does not have a phone number");
        return;
      }

      setWaSendingId(student.id);

      const totalFee = Number(student.totalFee ?? 0);
      const paidFee = Number(student.PayedFee ?? student.payedFee ?? 0);
      const due = Math.max(totalFee - paidFee, 0);

      const res = await makeAuthenticatedRequest("/api/send-whatsapp-template", {
        method: "POST",
          body: JSON.stringify({
          phone,
          template: "fee_update_notification",
          language: "en",
          // Template: "Hello {{1}}, This is a reminder that your fee payment of {{2}} is due. ..."
          bodyParams: [
            student.name || "Student",
            `₹${String(due)}`,
          ],
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to send WhatsApp message");

      alert("WhatsApp message sent successfully.");
    } catch (e) {
      console.error("Send WhatsApp template failed:", e);
      handleAuthError(e, handleAuthExpired);
      alert(e.message || "Failed to send WhatsApp message");
    } finally {
      setWaSendingId(null);
    }
  }

  function loadRazorpayScript() {
    return new Promise((resolve) => {
      if (typeof window !== "undefined" && window.Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  function openPaymentModal(student) {
    const totalFee = Number(student.totalFee ?? 0);
    const paidFee = Number(student.PayedFee ?? student.payedFee ?? 0);
    const due = Math.max(totalFee - paidFee, 0);
    
    if (due <= 0) {
      alert("No due amount remaining.");
      return;
    }
    
    setSelectedStudent(student);
    setPaymentAmount(due.toString());
    setPaymentMethod("online"); // Reset to default
    setShowPaymentModal(true);
  }

  function closePaymentModal() {
    setShowPaymentModal(false);
    setSelectedStudent(null);
    setPaymentAmount("");
    setPaymentMethod("online");
    setShowCashSuccess(false);
  }

  async function handleCashPayment() {
    if (!selectedStudent) return;

    const amount = Number(paymentAmount);
    if (amount <= 0) {
      alert("Please enter a valid amount.");
      return;
    }

    const totalFee = Number(selectedStudent.totalFee ?? 0);
    const paidFee = Number(selectedStudent.PayedFee ?? selectedStudent.payedFee ?? 0);
    const due = Math.max(totalFee - paidFee, 0);

    if (amount > due) {
      alert(`Payment amount cannot exceed the due amount of ₹${due}`);
      return;
    }

    // Confirm cash payment
    const confirmMessage = `Confirm cash payment of ₹${amount} received from ${selectedStudent.name}?\n\nThis will update the student's fee record immediately.`;
    if (!confirm(confirmMessage)) {
      return;
    }

    setIsProcessingPayment(true);

    try {
      // Update student fee directly for cash payment
      const updateResponse = await makeAuthenticatedRequest("/api/update-student-fee", {
        method: "POST",
        body: JSON.stringify({ 
          id: selectedStudent.id, 
          addAmount: amount,
          paymentMethod: "cash"
        }),
      });

      if (!updateResponse.ok) {
        const errorData = await updateResponse.json();
        throw new Error(`Failed to update student fee: ${errorData.error || 'Unknown error'}`);
      }

      const updateData = await updateResponse.json();
      console.log("Cash payment successful:", updateData);

      await fetchStudents();
      setShowCashSuccess(true);

      // Open printable receipt for cash payment
      const params = new URLSearchParams({
        payment_id: '',
        order_id: '',
        amount: String(Math.round(amount * 100)),
        studentId: selectedStudent.id,
        name: selectedStudent.name || '',
        email: selectedStudent.email || '',
        phone: selectedStudent.phone || selectedStudent.phone1 || '',
        course: Array.isArray(selectedStudent.coursesTitle) 
          ? selectedStudent.coursesTitle.join(', ') 
          : selectedStudent.coursesTitle || '',
        totalFee: String(Math.round(totalFee * 100)),
        paidFee: String(Math.round(paidFee * 100)),
        dueAmount: String(Math.round(due * 100)),
        date: new Date().toISOString(),
        paymentMethod: 'cash',
        type: 'fee_payment',
      });
      window.open(`/receipt?${params.toString()}`, '_blank');
      
      // Auto-close after 3 seconds
      setTimeout(() => {
        closePaymentModal();
      }, 3000);

    } catch (error) {
      console.error("Cash payment error:", error);
      handleAuthError(error, handleAuthExpired);
      alert(`Cash Payment Error: ${error.message}`);
    } finally {
      setIsProcessingPayment(false);
    }
  }

  async function handlePayFee() {
    if (!selectedStudent) return;

    if (paymentMethod === "cash") {
      await handleCashPayment();
      return;
    }

    // Online payment logic (existing code)
    const totalFee = Number(selectedStudent.totalFee ?? 0);
    const paidFee = Number(selectedStudent.PayedFee ?? selectedStudent.payedFee ?? 0);
    const due = Math.max(totalFee - paidFee, 0);
    const amount = Number(paymentAmount);

    if (amount <= 0) {
      alert("Please enter a valid amount.");
      return;
    }

    if (amount > due) {
      alert(`Payment amount cannot exceed the due amount of ₹${due}`);
      return;
    }

    setIsProcessingPayment(true);

    const scriptLoaded = await loadRazorpayScript();
    if (!scriptLoaded) {
      alert("Failed to load payment SDK. Please retry.");
      setIsProcessingPayment(false);
      return;
    }

    try {
      const orderRes = await makeAuthenticatedRequest("/api/payments/razorpay/order", {
        method: "POST",
        body: JSON.stringify({ amount: Math.round(amount * 100), receipt: selectedStudent.id }),
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok) throw new Error(orderData.error || "Failed to create order");

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "Course Fee Payment",
        description: selectedStudent.coursesTitle || "Payment",
        order_id: orderData.id,
        prefill: {
          name: selectedStudent.name,
          email: selectedStudent.email,
          contact: selectedStudent.phone1 || selectedStudent.phone,
        },
        handler: async function (response) {
          try {
            console.log("Payment response received:", response);
            
            // For now, let's skip verification and directly update the fee
            // This will help us identify if the issue is with verification or fee update
            console.log("Updating student fee directly...");
            
            const updateResponse = await makeAuthenticatedRequest("/api/update-student-fee", {
              method: "POST",
              body: JSON.stringify({ 
                id: selectedStudent.id, 
                addAmount: amount,
                paymentMethod: "online"
              }),
            });

            console.log("Update response status:", updateResponse.status);

            if (!updateResponse.ok) {
              const errorData = await updateResponse.json();
              console.error("Update error data:", errorData);
              throw new Error(`Failed to update student fee: ${errorData.error || 'Unknown error'}`);
            }

            const updateData = await updateResponse.json();
            console.log("Fee update successful:", updateData);

            await fetchStudents();
            closePaymentModal();

            // Open printable receipt for online payment by admin
            const params = new URLSearchParams({
              payment_id: response.razorpay_payment_id || '',
              order_id: response.razorpay_order_id || '',
              amount: String(Math.round(amount * 100)),
              studentId: selectedStudent.id,
              name: selectedStudent.name || '',
              email: selectedStudent.email || '',
              phone: selectedStudent.phone || selectedStudent.phone1 || '',
              course: Array.isArray(selectedStudent.coursesTitle) 
                ? selectedStudent.coursesTitle.join(', ') 
                : selectedStudent.coursesTitle || '',
              totalFee: String(Math.round(totalFee * 100)),
              paidFee: String(Math.round(paidFee * 100)),
              dueAmount: String(Math.round(due * 100)),
              date: new Date().toISOString(),
              paymentMethod: 'online',
              type: 'fee_payment',
            });
            window.open(`/receipt?${params.toString()}`, '_blank');
            
          } catch (e) {
            console.error("Payment processing error:", e);
            alert(`Payment Error: ${e.message}`);
          } finally {
            setIsProcessingPayment(false);
          }
        },
        modal: {
          ondismiss: function() {
            setIsProcessingPayment(false);
          }
        },
        theme: { color: "#10B981" },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      console.error(err);
      alert(err.message || "Payment failed to start.");
      setIsProcessingPayment(false);
    }
  }

  if (loading) {
    return (
      <CheckAdminAuth>
        <p className="text-center text-gray-600 mt-10">Loading students...</p>
      </CheckAdminAuth>
    );
  }

  return (
    <CheckAdminAuth>
      <div className="mx-auto p-6 bg-white shadow-md rounded-md">
        <button
          onClick={() => router.back()}
          disabled={isProcessingPayment}
          className={`mb-4 px-4 py-2 rounded ${
            isProcessingPayment 
              ? "bg-gray-400 cursor-not-allowed" 
              : "bg-gray-500 hover:bg-gray-600"
          } text-white`}
        >
          ⬅ Back
        </button>
        <h2 className="text-2xl font-bold mb-6 text-center text-green-700">
          👨‍🎓 Students List
        </h2>

        {/* Search by mobile number and Lock filter */}
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Search by mobile number"
            value={phoneQuery}
            onChange={(e) => setPhoneQuery(e.target.value)}
            disabled={isProcessingPayment}
            className={`flex-1 md:w-80 border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 ${
              isProcessingPayment ? "bg-gray-100 cursor-not-allowed" : ""
            }`}
          />
          <select
            value={lockFilter}
            onChange={(e) => setLockFilter(e.target.value)}
            disabled={isProcessingPayment}
            className={`border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 ${
              isProcessingPayment ? "bg-gray-100 cursor-not-allowed" : ""
            }`}
          >
            <option value="all">All Students</option>
            <option value="locked">🔒 Locked Only</option>
            <option value="unlocked">🔓 Unlocked Only</option>
          </select>
        </div>

        {students.length === 0 ? (
          <p className="text-gray-500 text-center">No students found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse border text-sm">
              <thead>
                <tr className="bg-gray-200">
                  <th className="border p-2">S.No</th>
                  <th className="border p-2">Name</th>
                  <th className="border p-2">Email</th>
                  <th className="border p-2">Password</th>
                  <th className="border p-2">Phone</th>
                  <th className="border p-2">Course</th>
                  <th className="border p-2">Total Fee</th>
                  <th className="border p-2">Due</th>
                  <th className="border p-2">Lock</th>
                  <th className="border p-2 min-w-[320px]">Action</th>
                </tr>
              </thead>
              <tbody>
                {students.filter((s) => {
                  // Filter by phone query
                  if (phoneQuery) {
                    const digits = String(s.phone1 || s.phone || "").replace(/\D/g, "");
                    const q = phoneQuery.replace(/\D/g, "");
                    if (!digits.includes(q)) return false;
                  }
                  
                  // Filter by lock status
                  const isLocked = Boolean(s.locked);
                  if (lockFilter === "locked" && !isLocked) return false;
                  if (lockFilter === "unlocked" && isLocked) return false;
                  
                  return true;
                }).map((s, index) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="border p-2 text-center">{index + 1}</td>
                    <td className="border p-2">{s.name}</td>
                    <td className="border p-2">{s.email}</td>
                    <td className="border p-2">{s.password || "-"}</td>
                    <td className="border p-2">
                      {s.phone1 || s.phone || "-"}
                    </td>
                    <td className="border p-2">
                      {Array.isArray(s.coursesTitle) 
                        ? s.coursesTitle.join(', ') 
                        : s.coursesTitle || "-"}
                    </td>
                    <td className="border p-2">{s.totalFee || "-"}</td>
                    <td className="border p-2">{Number(s.totalFee ?? 0) - Number(s.PayedFee ?? s.payedFee ?? 0)}</td>
                  <td className="border p-2 text-center">
                    <label className="inline-flex items-center cursor-pointer select-none">
                      <span className="mr-2 text-xs font-medium text-gray-700">
                        {Boolean(s.locked) ? "Locked" : "Unlocked"}
                      </span>
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={Boolean(s.locked)}
                        disabled={isProcessingPayment}
                        onChange={async () => {
                          try {
                            await updateDoc(doc(db, "students", s.id), { locked: !Boolean(s.locked) });
                            await fetchStudents();
                          } catch (e) {
                            alert(e?.message || "Failed to update lock status");
                          }
                        }}
                      />
                      <div className={`relative w-11 h-6 rounded-full transition-colors ${Boolean(s.locked) ? "bg-yellow-500" : "bg-gray-300"} peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-green-500`}>
                        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${Boolean(s.locked) ? "translate-x-5" : "translate-x-0"}`}></div>
                      </div>
                    </label>
                  </td>
                  <td className="border p-2 text-center">
                    <div className="flex flex-wrap justify-center gap-2 min-w-[320px]">
                    <button
                      onClick={() => openPaymentModal(s)}
                      disabled={isProcessingPayment}
                      className={`px-3 py-1 rounded ${
                        isProcessingPayment 
                          ? "bg-gray-400 cursor-not-allowed" 
                          : "bg-green-600 hover:bg-green-700"
                      } text-white`}
                    >
                      Pay Fee
                    </button>
                    <button
                      onClick={() => {
                        const params = new URLSearchParams({
                          name: s.name || '',
                          course: s.coursesTitle || 'Course',
                          certNo: `${new Date().getFullYear()}-${s.id.substring(0,6)}`,
                          issued: new Date().toLocaleDateString(),
                        });
                        window.open(`/certificate?${params.toString()}`, '_blank');
                      }}
                      disabled={isProcessingPayment}
                      className={`px-3 py-1 rounded ${
                        isProcessingPayment 
                          ? "bg-gray-400 cursor-not-allowed" 
                          : "bg-indigo-600 hover:bg-indigo-700"
                      } text-white`}
                    >
                      Generate Certificate
                    </button>
                    <button
                      onClick={() => handleSendWhatsappTemplate(s)}
                      disabled={isProcessingPayment || waSendingId === s.id}
                      className={`px-3 py-1 rounded ${
                        isProcessingPayment || waSendingId === s.id
                          ? "bg-gray-400 cursor-not-allowed"
                          : "bg-emerald-600 hover:bg-emerald-700"
                      } text-white`}
                    >
                      {waSendingId === s.id ? "Sending..." : "WhatsApp"}
                    </button>
                    {(currentUserRole === "superadmin" || currentUserRole === "admin") && (
                      <button
                        onClick={() => openEditFeeModal(s)}
                        disabled={isProcessingPayment}
                        className={`px-3 py-1 rounded ${
                          isProcessingPayment 
                            ? "bg-gray-400 cursor-not-allowed" 
                            : "bg-purple-600 hover:bg-purple-700"
                        } text-white`}
                      >
                        Edit Fee
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteStudent(s.id)}
                      disabled={isProcessingPayment}
                      className={`px-3 py-1 rounded ${
                        isProcessingPayment 
                          ? "bg-gray-400 cursor-not-allowed" 
                          : "bg-red-500 hover:bg-red-600"
                      } text-white`}
                    >
                      Delete
                    </button>
                    </div>
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Grand Total Summary */}
        {students.length > 0 && (
          <div className="mt-6 bg-gray-50 p-4 rounded-lg border">
            <h3 className="text-lg font-semibold mb-4 text-center text-gray-800">
              📊 Fee Summary
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white p-4 rounded-lg border text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {students.length}
                </div>
                <div className="text-sm text-gray-600">Total Students</div>
              </div>
              <div className="bg-white p-4 rounded-lg border text-center">
                <div className="text-2xl font-bold text-green-600">
                  ₹{students.reduce((sum, s) => sum + Number(s.totalFee ?? 0), 0).toLocaleString()}
                </div>
                <div className="text-sm text-gray-600">Total Fee</div>
              </div>
              <div className="bg-white p-4 rounded-lg border text-center">
                <div className="text-2xl font-bold text-blue-600">
                  ₹{students.reduce((sum, s) => sum + Number(s.PayedFee ?? s.payedFee ?? 0), 0).toLocaleString()}
                </div>
                <div className="text-sm text-gray-600">Total Paid</div>
              </div>
              <div className="bg-white p-4 rounded-lg border text-center">
                <div className="text-2xl font-bold text-red-600">
                  ₹{students.reduce((sum, s) => {
                    const totalFee = Number(s.totalFee ?? 0);
                    const paidFee = Number(s.PayedFee ?? s.payedFee ?? 0);
                    return sum + Math.max(totalFee - paidFee, 0);
                  }, 0).toLocaleString()}
                </div>
                <div className="text-sm text-gray-600">Pending Amount</div>
              </div>
            </div>
          </div>
        )}

        {/* Payment Modal */}
        {showPaymentModal && selectedStudent && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-lg max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold mb-4 text-center">
                Payment for {selectedStudent.name}
              </h3>
              
              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-2">
                  <strong>Total Fee:</strong> ₹{selectedStudent.totalFee || 0}
                </p>
                <p className="text-sm text-gray-600 mb-2">
                  <strong>Paid Amount:</strong> ₹{selectedStudent.PayedFee || selectedStudent.payedFee || 0}
                </p>
                <p className="text-sm text-gray-600 mb-4">
                  <strong>Due Amount:</strong> ₹{Number(selectedStudent.totalFee ?? 0) - Number(selectedStudent.PayedFee ?? selectedStudent.payedFee ?? 0)}
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Payment Amount (₹)
                </label>
                <input
                  type="number"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  min="0"
                  max={Number(selectedStudent.totalFee ?? 0) - Number(selectedStudent.PayedFee ?? selectedStudent.payedFee ?? 0)}
                  step="0.01"
                  disabled={isProcessingPayment}
                  className={`w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 ${
                    isProcessingPayment ? "bg-gray-100 cursor-not-allowed" : ""
                  }`}
                  placeholder="Enter payment amount"
                />
              </div>

              {/* Payment Method Selection */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Payment Method
                </label>
                <div className="space-y-2">
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="online"
                      checked={paymentMethod === "online"}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      disabled={isProcessingPayment}
                      className="text-green-600 focus:ring-green-500"
                    />
                    <div className="flex items-center gap-2">
                      <CreditCard size={16} className="text-blue-600" />
                      <span className="text-sm">Online Payment Gateway</span>
                    </div>
                  </label>
                  
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="cash"
                      checked={paymentMethod === "cash"}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      disabled={isProcessingPayment}
                      className="text-green-600 focus:ring-green-500"
                    />
                    <div className="flex items-center gap-2">
                      ₹
                      <span className="text-sm"> Cash Payment</span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Payment Method Description */}
              {paymentMethod === "online" && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-xs text-blue-700">
                    <strong>Online Payment:</strong> You will be redirected to a secure payment gateway to complete the transaction.
                  </p>
                </div>
              )}

              {paymentMethod === "cash" && (
                <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <p className="text-xs text-green-700">
                    <strong>Cash Payment:</strong> Record the cash payment received. The student&apos;s fee will be updated immediately.
                  </p>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={handlePayFee}
                  disabled={isProcessingPayment}
                  className={`flex-1 px-4 py-2 rounded flex items-center justify-center gap-2 ${
                    isProcessingPayment 
                      ? "bg-gray-400 cursor-not-allowed" 
                      : paymentMethod === "online"
                      ? "bg-blue-600 hover:bg-blue-700"
                      : "bg-green-600 hover:bg-green-700"
                  } text-white`}
                >
                  {isProcessingPayment ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      Processing...
                    </>
                  ) : paymentMethod === "online" ? (
                    <>
                      <CreditCard size={16} />
                      Proceed to Payment
                    </>
                  ) : (
                    <>
                      <DollarSign size={16} />
                      Record Cash Payment
                    </>
                  )}
                </button>
                <button
                  onClick={closePaymentModal}
                  disabled={isProcessingPayment}
                  className={`flex-1 px-4 py-2 rounded ${
                    isProcessingPayment 
                      ? "bg-gray-400 cursor-not-allowed" 
                      : "bg-gray-500 hover:bg-gray-600"
                  } text-white`}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cash Payment Success Modal */}
        {showCashSuccess && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-lg max-w-md w-full mx-4 text-center">
              <CheckCircle size={48} className="text-green-600 mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2 text-green-800">
                Cash Payment Successful!
              </h3>
              <p className="text-gray-600 mb-4">
                Payment of ₹{paymentAmount} has been recorded for {selectedStudent?.name}
              </p>
              <p className="text-sm text-gray-500">
                The student&apos;s fee has been updated in the system.
              </p>
            </div>
          </div>
        )}

        {/* Payment Processing Overlay */}
        {isProcessingPayment && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-8 rounded-lg shadow-lg text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600 mx-auto mb-4"></div>
              <h3 className="text-lg font-semibold mb-2">
                {paymentMethod === "online" ? "Processing Online Payment..." : "Recording Cash Payment..."}
              </h3>
              <p className="text-gray-600 text-sm">
                Please do not refresh the page or navigate away.
              </p>
              <p className="text-gray-500 text-xs mt-2">
                This may take a few moments.
              </p>
            </div>
          </div>
        )}

        {/* Edit Total Fee Modal - Only for Admin */}
        {showEditFeeModal && editFeeStudent && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-6 rounded-lg shadow-lg max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold mb-4 text-center">
                Edit Total Fee for {editFeeStudent.name}
              </h3>
              
              <div className="mb-4">
                <p className="text-sm text-gray-600 mb-2">
                  <strong>Current Total Fee:</strong> ₹{editFeeStudent.totalFee || 0}
                </p>
                <p className="text-sm text-gray-600 mb-4">
                  <strong>Paid Amount:</strong> ₹{editFeeStudent.PayedFee || editFeeStudent.payedFee || 0}
                </p>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  New Total Fee (₹) <span className="text-purple-600 text-xs">Admin Only</span>
                </label>
                <input
                  type="number"
                  value={newTotalFee}
                  onChange={(e) => setNewTotalFee(e.target.value)}
                  min="0"
                  step="0.01"
                  className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 border-purple-300 bg-purple-50"
                  placeholder="Enter new total fee amount"
                />
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-4">
                <p className="text-xs text-yellow-800">
                  ⚠️ <strong>Warning:</strong> Changing the total fee will affect the due amount calculation. This action should only be done for corrections or special cases.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleUpdateTotalFee}
                  className="flex-1 px-4 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white"
                >
                  Update Total Fee
                </button>
                <button
                  onClick={closeEditFeeModal}
                  className="flex-1 px-4 py-2 rounded bg-gray-500 hover:bg-gray-600 text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CheckAdminAuth>
  );
}



