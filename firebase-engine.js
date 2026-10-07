// =====================================================================
// منظومة رَقِـيـبْ - محرك فايربيز فائق السرعة والموفر للباندويث (v25.0 - Atomic Architecture)
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getDatabase, ref, set, get, update, remove, child, runTransaction 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBAmXo0ytDmjytf71LrBC4KIadNIzHBzxw",
  authDomain: "raqeeb-1544a.firebaseapp.com",
  databaseURL: "https://raqeeb-1544a-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "raqeeb-1544a",
  storageBucket: "raqeeb-1544a.firebasestorage.app",
  messagingSenderId: "1076860782684",
  appId: "1:1076860782684:web:713d4b6ba599d00792be99",
  measurementId: "G-BHR7D4ZCH7"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// مساعد عام لتحويل الـ Snapshot إلى مصفوفة آمنة
const snapshotToArray = (snap) => {
  if (!snap || !snap.exists()) return [];
  const val = snap.val();
  return Array.isArray(val) ? val.filter(Boolean) : Object.values(val);
};

// حساب سعر الطالب بناءً على نظام الشرائح
export function calculateTierRate(studentCount) {
  if (studentCount > 1000) return 1.55;
  if (studentCount > 500) return 1.80;
  if (studentCount > 300) return 2.00;
  return 2.34;
}

// ==========================================
// 1. دوال المعلم (Teacher Engine) والتحقق المسبق
// ==========================================

export async function dbVerifyTeacher(code) {
  try {
    const clean = code.toString().trim();
    const tSnap = await get(ref(db, `teachers/${clean}/profile`));
    if (tSnap.exists()) {
      const prof = tSnap.val();
      if (prof.status === "Approved") {
        return { status: "success", teacher: { id: clean, ...prof } };
      }
      return { status: "error", message: "الحساب قيد المراجعة ولم يتم اعتماده بعد" };
    }
    return { status: "error", message: "كود المعلم غير صحيح" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetTeacherWorkspace(teacherId) {
  try {
    const cleanId = teacherId.toString().trim();

    const results = await Promise.allSettled([
      get(ref(db, `teacher_students/${cleanId}`)),
      get(ref(db, `teachers/${cleanId}/groups`)),
      get(ref(db, `content_vault/${cleanId}/lessons`)),
      get(ref(db, `content_vault/${cleanId}/exams`)),
      get(ref(db, `content_vault/${cleanId}/books`)),
      get(ref(db, `payments_ledger/${cleanId}`)),
      get(ref(db, `teachers/${cleanId}/wallet`)),
      get(ref(db, `book_reservations/${cleanId}`))
    ]);

    const getValue = (result, fallback) => {
      if (result.status === 'fulfilled' && result.value && result.value.exists()) {
        const val = result.value.val();
        return Array.isArray(val) ? val.filter(Boolean) : val;
      }
      return fallback;
    };

    const toArr = (result) => {
      const val = getValue(result, []);
      return Array.isArray(val) ? val : Object.values(val);
    };

    const walletVal = getValue(results[6], { balance: 0, transactions: {} });
    const bookReservationsVal = toArr(results[7]);

    return {
      status: "success",
      students: toArr(results[0]),
      classes: toArr(results[1]),
      lessons: toArr(results[2]),
      exams: toArr(results[3]),
      books: toArr(results[4]),
      payments: toArr(results[5]),
      wallet: walletVal,
      bookReservations: bookReservationsVal
    };
  } catch (e) {
    console.error("Error in dbGetTeacherWorkspace:", e);
    return { status: "error", message: e.toString() };
  }
}

// فحص وخصم رصيد محفظة المعلم ذرياً (Atomic Transaction)
export async function dbAtomicDeductTeacherWallet(teacherId, amount, txDescription) {
  try {
    const cleanTId = teacherId.toString().trim();
    const walletRef = ref(db, `teachers/${cleanTId}/wallet`);
    const txId = "FEE-" + Math.floor(10000 + Math.random() * 90000);
    const dateStr = new Date().toISOString().split("T")[0];

    const result = await runTransaction(walletRef, (currentData) => {
      if (!currentData) {
        currentData = { balance: 0, transactions: {} };
      }
      const currentBalance = Number(currentData.balance || 0);
      if (currentBalance < amount) {
        return; // إلغاء المعاملة لعدم كفاية الرصيد
      }

      currentData.balance = Math.round((currentBalance - amount) * 100) / 100;
      if (!currentData.transactions) currentData.transactions = {};
      
      currentData.transactions[txId] = {
        id: txId,
        type: txDescription,
        amount: -amount,
        date: dateStr
      };
      return currentData;
    });

    if (!result.committed) {
      return { status: "error", message: "رصيد المحفظة لا يكفي لتغطية التكلفة المطلوبة." };
    }
    return { status: "success", newBalance: result.snapshot.val().balance, txId };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveStudent(teacherId, student, isNew = false) {
  try {
    const cleanTId = teacherId.toString().trim();
    const sId = student.id.toString().trim();

    if (isNew) {
      // حساب تكلفة إضافة الطالب الجديد حسب الشريحة
      const studentsSnap = await get(ref(db, `teacher_students/${cleanTId}`));
      const currentCount = studentsSnap.exists() ? Object.keys(studentsSnap.val()).length : 0;
      const rate = calculateTierRate(currentCount + 1);

      // خصم التكلفة ذرياً من محفظة المعلم
      const deductRes = await dbAtomicDeductTeacherWallet(cleanTId, rate, `خصم اشتراك طالب جديد [ID: ${sId}]`);
      if (deductRes.status === "error") {
        return { status: "error", message: deductRes.message };
      }
    }

    const updates = {};
    updates[`teacher_students/${cleanTId}/${sId}`] = {
      id: sId,
      name: student.name,
      phone: student.phone || "",
      parentPhone: student.parentPhone || "",
      grade: student.grade || "",
      groupCode: student.groupCode || "",
      discountType: student.discountType || "لا يوجد",
      discountValue: Number(student.discountValue || 0),
      notes: student.notes || "",
      walletBalance: Number(student.walletBalance || 0)
    };

    updates[`student_auth_index/${sId}`] = {
      tId: cleanTId,
      act: true
    };

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbDeleteStudent(teacherId, studentId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const sId = studentId.toString().trim();
    const updates = {};
    updates[`teacher_students/${cleanTId}/${sId}`] = null;
    updates[`student_auth_index/${sId}`] = null;
    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveGroup(teacherId, group) {
  try {
    const cleanTId = teacherId.toString().trim();
    await set(ref(db, `teachers/${cleanTId}/groups/${group.groupCode}`), group);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbDeleteGroup(teacherId, groupCode) {
  try {
    const cleanTId = teacherId.toString().trim();
    await remove(ref(db, `teachers/${cleanTId}/groups/${groupCode}`));
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveAttendanceSession(teacherId, sessionData) {
  try {
    const cleanTId = teacherId.toString().trim();
    const date = new Date().toISOString().split("T")[0];
    const updates = {};
    const basePath = `attendance_records/${cleanTId}/${sessionData.groupCode}/${date}`;

    sessionData.students.forEach(s => {
      updates[`${basePath}/${s.studentId}`] = {
        name: s.studentName,
        parentPhone: s.parentPhone || s.phone || "",
        status: s.status,
        time: new Date().toLocaleTimeString('ar-EG')
      };
    });

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetAttendanceLogs(teacherId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const snap = await get(ref(db, `attendance_records/${cleanTId}`));
    if (!snap.exists()) return { status: "success", logs: [] };

    const raw = snap.val();
    const logs = [];

    Object.keys(raw).forEach(grpCode => {
      Object.keys(raw[grpCode]).forEach(dateStr => {
        Object.keys(raw[grpCode][dateStr]).forEach(stdId => {
          const item = raw[grpCode][dateStr][stdId];
          logs.push({
            sessionId: `${dateStr}_${grpCode}`,
            date: dateStr,
            time: item.time || "",
            groupCode: grpCode,
            groupName: grpCode,
            studentId: stdId,
            studentName: item.name,
            parentPhone: item.parentPhone,
            status: item.status
          });
        });
      });
    });

    return { status: "success", logs };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSavePayment(teacherId, payment) {
  try {
    const cleanTId = teacherId.toString().trim();
    await set(ref(db, `payments_ledger/${cleanTId}/${payment.receiptId}`), payment);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveLesson(teacherId, lesson) {
  try {
    const cleanTId = teacherId.toString().trim();
    await set(ref(db, `content_vault/${cleanTId}/lessons/${lesson.lessonId}`), lesson);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbUnlockLesson(teacherId, lessonId, studentId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const lessonRef = ref(db, `content_vault/${cleanTId}/lessons/${lessonId}`);
    
    const result = await runTransaction(lessonRef, (lesson) => {
      if (!lesson) return;
      if (!lesson.unlockedStudents) lesson.unlockedStudents = [];
      if (!lesson.unlockedStudents.includes(studentId.toString())) {
        lesson.unlockedStudents.push(studentId.toString());
      }
      return lesson;
    });

    if (!result.committed) return { status: "error", message: "الحصة غير موجودة" };
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveExam(teacherId, exam) {
  try {
    const cleanTId = teacherId.toString().trim();
    await set(ref(db, `content_vault/${cleanTId}/exams/${exam.examId}`), exam);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveBook(teacherId, book) {
  try {
    const cleanTId = teacherId.toString().trim();
    await set(ref(db, `content_vault/${cleanTId}/books/${book.bookId}`), {
      ...book,
      stock: Number(book.stock || 0),
      reservedCount: Number(book.reservedCount || 0),
      depositAmount: Number(book.depositAmount || 0)
    });
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// ==========================================
// 2. دوال بوابة الطالب والعمليات الذرية
// ==========================================

export async function dbStudentLogin(studentId) {
  try {
    const sId = studentId.toString().trim();
    const authSnap = await get(ref(db, `student_auth_index/${sId}`));

    if (!authSnap.exists()) {
      return { status: "error", message: "كود الطالب غير مسجل في المنظومة" };
    }

    const { tId, act } = authSnap.val();
    const profSnap = await get(ref(db, `teacher_students/${tId}/${sId}`));
    const teacherSnap = await get(ref(db, `teachers/${tId}/profile`));

    return {
      status: "success",
      student: profSnap.exists() ? profSnap.val() : { id: sId, name: "طالب", walletBalance: 0 },
      teacherId: tId,
      teacherName: teacherSnap.exists() ? teacherSnap.val().name : "الأستاذ",
      isActive: act === true
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetStudentLessons(teacherId) {
  try {
    const cleanId = teacherId.toString().trim();
    const snap = await get(ref(db, `content_vault/${cleanId}/lessons`));
    return snapshotToArray(snap);
  } catch (e) {
    return [];
  }
}

export async function dbGetStudentBooks(teacherId) {
  try {
    const cleanId = teacherId.toString().trim();
    const snap = await get(ref(db, `content_vault/${cleanId}/books`));
    return snapshotToArray(snap);
  } catch (e) {
    return [];
  }
}

// شحن كود الرصيد ذرياً للطالب
export async function dbRedeemAccessCode(studentId, teacherId, codeText) {
  try {
    const cleanTId = teacherId.toString().trim();
    const cleanCode = codeText.toString().trim().toUpperCase();
    const cleanSId = studentId.toString().trim();

    const codeRef = ref(db, `access_codes/${cleanTId}/${cleanCode}`);
    let codeValue = 0;

    const codeTxResult = await runTransaction(codeRef, (codeData) => {
      if (!codeData) return; // الكود غير مسجل
      if (codeData.isUsed) return; // تم استخدامه مسبقاً

      codeData.isUsed = true;
      codeData.usedByStudentId = cleanSId;
      codeData.usedAt = new Date().toISOString();
      codeValue = Number(codeData.value || 0);
      return codeData;
    });

    if (!codeTxResult.committed) {
      return { status: "error", message: "كود الشحن غير صحيح أو تم استخدامه مسبقاً!" };
    }

    // إضافة الرصيد لمحفظة الطالب ذرياً
    const stdRef = ref(db, `teacher_students/${cleanTId}/${cleanSId}`);
    const stdTxResult = await runTransaction(stdRef, (stdData) => {
      if (!stdData) return;
      stdData.walletBalance = Number(stdData.walletBalance || 0) + codeValue;
      return stdData;
    });

    return { 
      status: "success", 
      addedValue: codeValue, 
      newBalance: stdTxResult.snapshot.val().walletBalance 
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// شراء حصة مسجلة من رصيد محفظة الطالب ذرياً
export async function dbStudentBuyLesson(studentId, teacherId, lessonId, price) {
  try {
    const cleanTId = teacherId.toString().trim();
    const cleanSId = studentId.toString().trim();
    const cleanLId = lessonId.toString().trim();

    // 1. خصم ثمن الحصة من رصيد الطالب ذرياً
    const stdRef = ref(db, `teacher_students/${cleanTId}/${cleanSId}`);
    const stdTx = await runTransaction(stdRef, (stdData) => {
      if (!stdData) return;
      const currentBalance = Number(stdData.walletBalance || 0);
      if (currentBalance < price) {
        return; // الرصيد لا يكفي
      }
      stdData.walletBalance = Math.round((currentBalance - price) * 100) / 100;
      return stdData;
    });

    if (!stdTx.committed) {
      return { status: "error", message: "رصيد محفظتك لا يكفي لشراء هذه الحصة! يرجى شحن الرصيد أولاً." };
    }

    // 2. فك قفل الحصة في قائمة الحصص ذرياً
    const lessonRef = ref(db, `content_vault/${cleanTId}/lessons/${cleanLId}`);
    await runTransaction(lessonRef, (lesson) => {
      if (!lesson) return;
      if (!lesson.unlockedStudents) lesson.unlockedStudents = [];
      if (!lesson.unlockedStudents.includes(cleanSId)) {
        lesson.unlockedStudents.push(cleanSId);
      }
      return lesson;
    });

    return { status: "success", newBalance: stdTx.snapshot.val().walletBalance };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// =====================================================================
// 3. نظام المخزن، حجز المذكرات، وخصم الديبوزت الذري (Inventory & Deposit)
// =====================================================================

export async function dbReserveBookWithDepositAtomic(teacherId, studentId, studentName, bookId, qty = 1) {
  try {
    const cleanTId = teacherId.toString().trim();
    const cleanSId = studentId.toString().trim();
    const cleanBId = bookId.toString().trim();

    // 1. التحقق من المذكرة والمخزون
    const bookSnap = await get(ref(db, `content_vault/${cleanTId}/books/${cleanBId}`));
    if (!bookSnap.exists()) {
      return { status: "error", message: "المذكرة غير موجودة في المخزن." };
    }
    const book = bookSnap.val();
    const availableStock = Number(book.stock || 0);
    if (availableStock < qty) {
      return { status: "error", message: `المخزون المتوفر لا يكفي! المتبقي بالمخزن: ${availableStock} نسخة فقط.` };
    }

    const fullPrice = Number(book.price || 0) * qty;
    // العربون: القيمة المحددة بالمذكرة أو 25% من الإجمالي افتراضياً
    const depositRequired = Number(book.depositAmount || Math.round(fullPrice * 0.25));

    // 2. خصم العربون ذرياً من رصيد الطالب
    const studentRef = ref(db, `teacher_students/${cleanTId}/${cleanSId}`);
    const studentTx = await runTransaction(studentRef, (stdData) => {
      if (!stdData) return;
      const currentBalance = Number(stdData.walletBalance || 0);
      if (currentBalance < depositRequired) {
        return; // الرصيد لا يكفي لدفع العربون
      }
      stdData.walletBalance = Math.round((currentBalance - depositRequired) * 100) / 100;
      return stdData;
    });

    if (!studentTx.committed) {
      return { 
        status: "error", 
        message: `رصيد محفظتك لا يكفي لسداد عربون الحجز المطلوب (${depositRequired} ج.م)! يرجى شحن الرصيد أولاً.` 
      };
    }

    // 3. تقليل المخزون وزيادة الكمية المحجوزة ذرياً
    const bookRef = ref(db, `content_vault/${cleanTId}/books/${cleanBId}`);
    await runTransaction(bookRef, (bData) => {
      if (!bData) return;
      bData.stock = Math.max(0, Number(bData.stock || 0) - qty);
      bData.reservedCount = Number(bData.reservedCount || 0) + qty;
      return bData;
    });

    // 4. إنشاء سجل الحجز وتوثيق سند العربون المالي
    const resId = "RES-" + Math.floor(10000 + Math.random() * 90000);
    const dateStr = new Date().toISOString().split("T")[0];

    const reservationData = {
      id: resId,
      bookId: cleanBId,
      bookTitle: book.title,
      studentId: cleanSId,
      studentName: studentName,
      qty: qty,
      fullPrice: fullPrice,
      depositPaid: depositRequired,
      remainingAmount: Math.max(0, fullPrice - depositRequired),
      status: "معلق (عربون مدفوع)",
      date: dateStr,
      timestamp: Date.now()
    };

    const updates = {};
    updates[`book_reservations/${cleanTId}/${resId}`] = reservationData;
    updates[`payments_ledger/${cleanTId}/DEP-${resId}`] = {
      receiptId: `DEP-${resId}`,
      studentId: cleanSId,
      studentName: studentName,
      teacherId: cleanTId,
      paymentType: `عربون حجز مذكرة: ${book.title}`,
      amountDue: fullPrice,
      amountPaid: depositRequired,
      remaining: Math.max(0, fullPrice - depositRequired),
      notes: `حجز رقم [${resId}] - مخصوم من المحفظة`,
      date: dateStr
    };

    await update(ref(db), updates);

    return { 
      status: "success", 
      reservationId: resId, 
      depositDeducted: depositRequired,
      remaining: reservationData.remainingAmount 
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// تسليم المذكرة للطلب وتحصيل المتبقي
export async function dbFulfillBookReservationAtomic(teacherId, reservationId, collectRemaining = true) {
  try {
    const cleanTId = teacherId.toString().trim();
    const resRef = ref(db, `book_reservations/${cleanTId}/${reservationId}`);
    const resSnap = await get(resRef);
    if (!resSnap.exists()) return { status: "error", message: "طلب الحجز غير موجود." };

    const reservation = resSnap.val();
    if (reservation.status === "تم التسليم ✓") {
      return { status: "error", message: "تم تسليم هذا الحجز مسبقاً." };
    }

    const updates = {};
    updates[`book_reservations/${cleanTId}/${reservationId}/status`] = "تم التسليم ✓";
    updates[`book_reservations/${cleanTId}/${reservationId}/deliveredAt`] = new Date().toISOString();

    if (collectRemaining && reservation.remainingAmount > 0) {
      const recId = "BAL-" + Math.floor(10000 + Math.random() * 90000);
      updates[`payments_ledger/${cleanTId}/${recId}`] = {
        receiptId: recId,
        studentId: reservation.studentId,
        studentName: reservation.studentName,
        teacherId: cleanTId,
        paymentType: `المتبقي من تسليم مذكرة: ${reservation.bookTitle}`,
        amountDue: reservation.remainingAmount,
        amountPaid: reservation.remainingAmount,
        remaining: 0,
        notes: `استكمال سداد الحجز [${reservationId}] عند الاستلام`,
        date: new Date().toISOString().split("T")[0]
      };
      updates[`book_reservations/${cleanTId}/${reservationId}/remainingAmount`] = 0;
    }

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// إلغاء الحجز ورد العربون للمحفظة والنسخة للمخزن ذرياً
export async function dbCancelBookReservationAtomic(teacherId, reservationId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const resRef = ref(db, `book_reservations/${cleanTId}/${reservationId}`);
    const resSnap = await get(resRef);
    if (!resSnap.exists()) return { status: "error", message: "الحجز غير موجود." };

    const resData = resSnap.val();
    if (resData.status === "تم التسليم ✓" || resData.status === "ملغي ومسترد") {
      return { status: "error", message: "لا يمكن إلغاء الحجز في حالته الحالية." };
    }

    // 1. إعادة العربون لمحفظة الطالب ذرياً
    const stdRef = ref(db, `teacher_students/${cleanTId}/${resData.studentId}`);
    await runTransaction(stdRef, (std) => {
      if (!std) return;
      std.walletBalance = Number(std.walletBalance || 0) + Number(resData.depositPaid || 0);
      return std;
    });

    // 2. إعادة النسخة إلى المخزون ذرياً
    const bookRef = ref(db, `content_vault/${cleanTId}/books/${resData.bookId}`);
    await runTransaction(bookRef, (b) => {
      if (!b) return;
      b.stock = Number(b.stock || 0) + Number(resData.qty || 1);
      b.reservedCount = Math.max(0, Number(b.reservedCount || 0) - Number(resData.qty || 1));
      return b;
    });

    // 3. تحديث حالة الحجز
    await update(resRef, {
      status: "ملغي ومسترد",
      cancelledAt: new Date().toISOString()
    });

    return { status: "success", refundedAmount: resData.depositPaid };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// ==========================================
// 4. دوال لوحة الإدارة (Super Admin)
// ==========================================

export async function dbGetAdminOverview() {
  try {
    const [teachersSnap, indexSnap, requestsSnap] = await Promise.all([
      get(ref(db, "teachers")),
      get(ref(db, "student_auth_index")),
      get(ref(db, "access_requests"))
    ]);

    const teachers = {};
    if (teachersSnap.exists()) {
      const rawT = teachersSnap.val();
      Object.keys(rawT).forEach(tId => {
        teachers[tId] = { 
          id: tId, 
          ...rawT[tId].profile, 
          walletBalance: rawT[tId].wallet ? rawT[tId].wallet.balance : 0 
        };
      });
    }

    const studentsIndex = indexSnap.exists() ? indexSnap.val() : {};
    const studentsSnap = await get(ref(db, "teacher_students"));
    const allStudents = [];
    if (studentsSnap.exists()) {
      const rawTS = studentsSnap.val();
      Object.keys(rawTS).forEach(tId => {
        Object.keys(rawTS[tId]).forEach(sId => {
          allStudents.push({
            ...rawTS[tId][sId],
            teacherId: tId,
            isActive: studentsIndex[sId] ? studentsIndex[sId].act === true : false
          });
        });
      });
    }

    const requests = requestsSnap.exists() ? Object.values(requestsSnap.val()) : [];

    return {
      status: "success",
      teachers: Object.values(teachers),
      students: allStudents,
      requests: requests
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbApproveTeacherDirect(teacherId, teacherData) {
  try {
    const cleanTId = teacherId.toString().trim();
    const updates = {};
    updates[`teachers/${cleanTId}/profile`] = {
      name: teacherData.name,
      subject: teacherData.subject,
      phone: teacherData.phone || "",
      governorate: teacherData.governorate || "",
      status: "Approved",
      createdAt: new Date().toISOString().split("T")[0]
    };
    updates[`teachers/${cleanTId}/wallet`] = {
      balance: 0,
      transactions: {}
    };
    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbToggleStudentActivation(studentId, teacherId, newStatus) {
  try {
    const sId = studentId.toString().trim();
    const cleanTId = teacherId.toString().trim();
    const updates = {};
    updates[`student_auth_index/${sId}`] = {
      tId: cleanTId,
      act: newStatus
    };
    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbTransferStudent(studentId, fromTeacherId, toTeacherId) {
  try {
    const sId = studentId.toString().trim();
    const cleanFrom = fromTeacherId.toString().trim();
    const cleanTo = toTeacherId.toString().trim();

    const sSnap = await get(ref(db, `teacher_students/${cleanFrom}/${sId}`));
    if (!sSnap.exists()) return { status: "error", message: "الطالب غير موجود لدى المعلم القديم" };

    const studentData = sSnap.val();
    const updates = {};
    updates[`teacher_students/${cleanFrom}/${sId}`] = null;
    updates[`teacher_students/${cleanTo}/${sId}`] = studentData;
    updates[`student_auth_index/${sId}/tId`] = cleanTo;

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbRepairAllStudentIndexes() {
  try {
    const tsSnap = await get(ref(db, "teacher_students"));
    if (!tsSnap.exists()) return { status: "success", repairedCount: 0 };

    const raw = tsSnap.val();
    const updates = {};
    let count = 0;

    Object.keys(raw).forEach(tId => {
      Object.keys(raw[tId]).forEach(sId => {
        updates[`student_auth_index/${sId}`] = {
          tId: tId,
          act: true
        };
        count++;
      });
    });

    await update(ref(db), updates);
    return { status: "success", repairedCount: count };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSubmitTeacherApplication(requestData) {
  try {
    const reqId = "REQ-" + Math.floor(10000 + Math.random() * 90000);
    await set(ref(db, `access_requests/${reqId}`), {
      requestId: reqId,
      ...requestData,
      status: "Pending",
      createdAt: new Date().toISOString().split("T")[0],
      timestamp: Date.now()
    });
    return { status: "success", requestId: reqId };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetAttendanceSummary(teacherId, groupCode = null) {
  try {
    const cleanTId = teacherId.toString().trim();
    const snap = await get(ref(db, `attendance_records/${cleanTId}`));
    if (!snap.exists()) return {};

    const raw = snap.val();
    const studentStats = {};

    Object.keys(raw).forEach(grp => {
      if (groupCode && grp !== groupCode) return;

      Object.keys(raw[grp]).forEach(dateStr => {
        Object.keys(raw[grp][dateStr]).forEach(sId => {
          const item = raw[grp][dateStr][sId];
          if (!studentStats[sId]) {
            studentStats[sId] = {
              name: item.name,
              groupCode: grp,
              presentCount: 0,
              absentCount: 0,
              totalSessions: 0
            };
          }

          studentStats[sId].totalSessions++;
          if (item.status === "Present") {
            studentStats[sId].presentCount++;
          } else {
            studentStats[sId].absentCount++;
          }
        });
      });
    });

    return studentStats;
  } catch (e) {
    return {};
  }
}

// ==========================================
// 5. دوال بوابة ولي الأمر (Parent Portal)
// ==========================================

export async function dbParentLogin(studentId, parentPhone) {
  try {
    const sId = studentId.toString().trim();
    const cleanPhone = parentPhone.toString().trim();

    const authSnap = await get(ref(db, `student_auth_index/${sId}`));
    if (!authSnap.exists()) return { status: "error", message: "كود الطالب غير صحيح" };

    const { tId } = authSnap.val();
    const profSnap = await get(ref(db, `teacher_students/${tId}/${sId}`));

    if (!profSnap.exists()) return { status: "error", message: "ملف الطالب غير موجود" };

    const studentData = profSnap.val();
    const storedPhone = (studentData.parentPhone || studentData.phone || "").toString().trim();

    if (storedPhone === cleanPhone || cleanPhone.endsWith(storedPhone.slice(-8))) {
      return { status: "success", teacherId: tId };
    }

    return { status: "error", message: "رقم هاتف ولي الأمر غير مطابق للمسجل في النظام" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetParentWorkspace(teacherId, studentId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const sId = studentId.toString().trim();

    const [studentSnap, teacherSnap, attSnap, examsSnap, paymentsSnap] = await Promise.all([
      get(ref(db, `teacher_students/${cleanTId}/${sId}`)),
      get(ref(db, `teachers/${cleanTId}/profile`)),
      get(ref(db, `attendance_records/${cleanTId}`)),
      get(ref(db, `content_vault/${cleanTId}/exams`)),
      get(ref(db, `payments_ledger/${cleanTId}`))
    ]);

    const student = studentSnap.exists() ? studentSnap.val() : {};
    const teacherName = teacherSnap.exists() ? teacherSnap.val().name : "الأستاذ";

    const attendance = [];
    if (attSnap.exists()) {
      const rawAtt = attSnap.val();
      Object.keys(rawAtt).forEach(grpCode => {
        Object.keys(rawAtt[grpCode]).forEach(dateStr => {
          if (rawAtt[grpCode][dateStr][sId]) {
            const item = rawAtt[grpCode][dateStr][sId];
            attendance.push({
              date: dateStr,
              time: item.time || "",
              groupName: grpCode,
              status: item.status
            });
          }
        });
      });
    }

    const exams = [];
    if (examsSnap.exists()) {
      const rawExams = examsSnap.val();
      Object.values(rawExams).forEach(ex => {
        const score = ex.scores && ex.scores[sId] !== undefined ? ex.scores[sId] : undefined;
        exams.push({
          title: ex.title,
          maxScore: ex.maxScore,
          date: ex.date,
          score: score
        });
      });
    }

    const payments = [];
    if (paymentsSnap.exists()) {
      const rawPays = paymentsSnap.val();
      Object.values(rawPays).forEach(p => {
        if (p.studentId.toString() === sId) {
          payments.push(p);
        }
      });
    }

    return {
      status: "success",
      student,
      teacherName,
      attendance: attendance.reverse(),
      exams,
      payments: payments.reverse()
    };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// ==========================================
// 6. شحن المحفظة وتوليد الأكواد (Wallet & Top-up)
// ==========================================

export async function dbSubmitWalletTopUpRequest(teacherId, amount, teacherName) {
  try {
    const cleanTId = teacherId.toString().trim();
    const reqId = "TOP-" + Math.floor(10000 + Math.random() * 90000);
    const updates = {};
    
    updates[`wallet_topup_requests/${reqId}`] = {
      requestId: reqId,
      teacherId: cleanTId,
      teacherName: teacherName || "معلم",
      amount: Number(amount),
      status: "Pending",
      createdAt: new Date().toISOString().split("T")[0],
      timestamp: Date.now()
    };

    updates[`teachers/${cleanTId}/wallet/transactions/${reqId}`] = {
      id: reqId,
      type: "طلب شحن معلق (بانتظار تأكيد الإدارة)",
      amount: Number(amount),
      date: new Date().toISOString().split("T")[0]
    };

    await update(ref(db), updates);
    return { status: "success", requestId: reqId };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetAdminTopUpRequests() {
  try {
    const snap = await get(ref(db, "wallet_topup_requests"));
    return snapshotToArray(snap);
  } catch (e) {
    return [];
  }
}

export async function dbAdminResolveWalletTopUp(requestId, teacherId, amount, approve = true) {
  try {
    const cleanTId = teacherId.toString().trim();
    const updates = {};
    
    if (approve) {
      const walletRef = ref(db, `teachers/${cleanTId}/wallet`);
      await runTransaction(walletRef, (wallet) => {
        if (!wallet) wallet = { balance: 0, transactions: {} };
        wallet.balance = Number(wallet.balance || 0) + Number(amount);
        if (!wallet.transactions) wallet.transactions = {};
        wallet.transactions[requestId] = {
          id: requestId,
          type: "شحن رصيد معتمد من الإدارة ✓",
          amount: Number(amount),
          date: new Date().toISOString().split("T")[0]
        };
        return wallet;
      });
      updates[`wallet_topup_requests/${requestId}/status`] = "Approved";
    } else {
      updates[`wallet_topup_requests/${requestId}/status`] = "Rejected";
      updates[`teachers/${cleanTId}/wallet/transactions/${requestId}/type`] = "طلب شحن مرفوض ✕";
    }

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbSaveAccessCodesBatch(teacherId, codesList, value) {
  try {
    const cleanTId = teacherId.toString().trim();
    const updates = {};
    
    codesList.forEach(code => {
      updates[`access_codes/${cleanTId}/${code}`] = {
        code,
        value: Number(value),
        isUsed: false,
        usedByStudentId: null,
        createdAt: new Date().toISOString().split("T")[0]
      };
    });

    await update(ref(db), updates);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetTeacherAccessCodes(teacherId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const snap = await get(ref(db, `access_codes/${cleanTId}`));
    return snapshotToArray(snap);
  } catch (e) {
    return [];
  }
}
