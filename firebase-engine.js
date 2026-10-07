// =====================================================================
// منظومة رَقِـيـبْ - محرك فايربيز فائق السرعة والموفر للباندويث (v24.0 - Full Upgraded Version)
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getDatabase, ref, set, get, update, remove, child 
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

// ==========================================
// 1. دوال المعلم (Teacher Engine) والشرائح والتحقق المسبق
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
    console.log("Fetching workspace safely for teacher:", cleanId);

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

    const walletVal = getValue(results[6], { balance: 0, transactions: [] });
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

export function calculateTierRate(studentCount) {
  if (studentCount > 1000) return 1.55;
  if (studentCount > 500) return 1.80;
  if (studentCount > 300) return 2.00;
  return 2.34;
}

export async function dbCheckAndDeductPrepaidWallet(teacherId, isNewStudent = true) {
  try {
    const cleanId = teacherId.toString().trim();
    const [studentsSnap, walletSnap] = await Promise.all([
      get(ref(db, `teacher_students/${cleanId}`)),
      get(ref(db, `teachers/${cleanId}/wallet`))
    ]);

    const currentStudentsCount = studentsSnap.exists() ? Object.keys(studentsSnap.val()).length : 0;
    const projectedCount = isNewStudent ? currentStudentsCount + 1 : currentStudentsCount;
    const rate = calculateTierRate(projectedCount);
    
    const requiredCostPerMonth = rate; 

    const wallet = walletSnap.exists() ? walletSnap.val() : { balance: 0, graceDaysLeft: 5, transactions: [] };
    const balance = Number(wallet.balance || 0);

    if (balance < requiredCostPerMonth) {
      let graceDays = wallet.graceDaysLeft !== undefined ? wallet.graceDaysLeft : 5;
      
      if (graceDays > 0 && isNewStudent) {
        return { 
          status: "warning", 
          message: `⚠️ تنبيه: رصيد المحفظة لا يكفي لتغطية تكلفة الطالب بالشريحة الجديدة (${rate} ج.م)، ولكنك في فترة السماح (${graceDays} أيام متبقية). يرجى الشحن قريباً.` 
        };
      } else if (graceDays <= 0) {
        return { 
          status: "error", 
          message: `❌ انتهت فترة السماح (5 أيام) ونفد رصيد المحفظة! يرجى شحن المحفظة فوراً لإضافة طلاب جدد أو استمرار التفعيل.` 
        };
      }
    }

    return { status: "success", requiredCost: requiredCostPerMonth };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

 export async function dbSaveStudent(teacherId, student, isNew = false) {
  try {
    const cleanTId = teacherId.toString().trim();
    const sId = student.id.toString().trim();
    const updates = {};

    if (isNew) {
      // 1. التحقق من الرصيد
      const checkRes = await dbCheckAndDeductPrepaidWallet(cleanTId, true);
      if (checkRes.status === "error") {
        return { status: "error", message: checkRes.message };
      }
      
      // 2. الخصم الفعلي وتوثيق العملية في Firebase (تمت الإضافة)
      const walletSnap = await get(ref(db, `teachers/${cleanTId}/wallet`));
      const currentWallet = walletSnap.exists() ? walletSnap.val() : { balance: 0 };
      const rate = checkRes.requiredCost;
      const newBalance = Number(currentWallet.balance || 0) - rate;
      const txId = "FEE-" + Math.floor(10000 + Math.random() * 90000);
      
      updates[`teachers/${cleanTId}/wallet/balance`] = newBalance;
      updates[`teachers/${cleanTId}/wallet/transactions/${txId}`] = {
        id: txId,
        type: `خصم اشتراك طالب جديد [ID: ${sId}]`,
        amount: -rate,
        date: new Date().toISOString().split("T")[0]
      };
    }

    updates[`teacher_students/${cleanTId}/${sId}`] = {
      id: sId,
      name: student.name,
      phone: student.phone || "",
      parentPhone: student.parentPhone || "",
      grade: student.grade || "",
      groupCode: student.groupCode || "",
      discountType: student.discountType || "لا يوجد",
      discountValue: Number(student.discountValue || 0),
      notes: student.notes || ""
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
    const snap = await get(lessonRef);
    if (!snap.exists()) return { status: "error", message: "الحصة غير موجودة" };

    const lesson = snap.val();
    const unlocked = lesson.unlockedStudents || [];
    if (!unlocked.includes(studentId.toString())) {
      unlocked.push(studentId.toString());
      await update(lessonRef, { unlockedStudents: unlocked });
    }
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
    await set(ref(db, `content_vault/${cleanTId}/books/${book.bookId}`), book);
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// ==========================================
// 2. دوال بوابة الطالب
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
      student: profSnap.exists() ? profSnap.val() : { id: sId, name: "طالب" },
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
    console.error("Error in dbGetStudentLessons:", e);
    return [];
  }
}

// ==========================================
// 3. دوال لوحة الإدارة والتحكم الشامل (Super Admin)
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
        teachers[tId] = { id: tId, ...rawT[tId].profile };
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

export async function dbGetStudentFinancialLedger(teacherId, studentId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const snap = await get(ref(db, `payments_ledger/${cleanTId}`));
    if (!snap.exists()) return { totalPaid: 0, totalDue: 0, balance: 0, receipts: [] };

    const raw = snap.val();
    const receipts = Object.values(raw).filter(p => p.studentId.toString() === studentId.toString());

    const totalPaid = receipts.reduce((sum, r) => sum + Number(r.amountPaid || 0), 0);
    const totalRemaining = receipts.reduce((sum, r) => sum + Number(r.remaining || 0), 0);

    return {
      totalPaid,
      totalRemaining,
      receipts: receipts.reverse()
    };
  } catch (e) {
    return { totalPaid: 0, totalRemaining: 0, receipts: [] };
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
// 8. دوال بوابة ولي الأمر (Parent Portal)
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

    return { status: "error", message: "رقم هاتف ولي الأمر غير مطابق المسجل في النظام" };
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
// 4. ميزات إضافية للمخزن، شحن المحفظة، وأكواد الفيديوهات (Added Features v24.0)
// ==========================================

// أ. إدارة حجوزات ومخزن المذكرات سحابياً
export async function dbSaveBookReservation(teacherId, reservation) {
  try {
    const cleanTId = teacherId.toString().trim();
    const resId = reservation.id || "RES-" + Math.floor(1000 + Math.random() * 9000);
    await set(ref(db, `book_reservations/${cleanTId}/${resId}`), {
      ...reservation,
      id: resId,
      timestamp: Date.now()
    });
    return { status: "success", reservationId: resId };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbGetBookReservations(teacherId) {
  try {
    const cleanTId = teacherId.toString().trim();
    const snap = await get(ref(db, `book_reservations/${cleanTId}`));
    return snapshotToArray(snap);
  } catch (e) {
    return [];
  }
}

export async function dbUpdateBookReservationStatus(teacherId, reservationId, newStatus) {
  try {
    const cleanTId = teacherId.toString().trim();
    await update(ref(db, `book_reservations/${cleanTId}/${reservationId}`), { status: newStatus });
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

// ب. نظام شحن المحفظة المعلق وتأكيد الأدمن
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
      const walletSnap = await get(ref(db, `teachers/${cleanTId}/wallet`));
      const currentWallet = walletSnap.exists() ? walletSnap.val() : { balance: 0, transactions: [] };
      const newBalance = Number(currentWallet.balance || 0) + Number(amount);

      updates[`teachers/${cleanTId}/wallet/balance`] = newBalance;
      updates[`wallet_topup_requests/${requestId}/status`] = "Approved";
      updates[`teachers/${cleanTId}/wallet/transactions/${requestId}/type`] = "شحن رصيد معتمد من الإدارة ✓";
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

// ج. نظام محفظة الطالب والأكواد المالية
export async function dbSaveAccessCodesBatch(teacherId, codesList, value) {
  try {
    const cleanTId = teacherId.toString().trim();
    const updates = {};
    
    codesList.forEach(code => {
      updates[`access_codes/${cleanTId}/${code}`] = {
        code,
        value: Number(value), // القيمة المالية بدلاً من ربطها بحصة
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

export async function dbRedeemAccessCode(studentId, teacherId, codeText) {
  try {
    const cleanTId = teacherId.toString().trim();
    const cleanCode = codeText.toString().trim().toUpperCase();
    
    const codeRef = ref(db, `access_codes/${cleanTId}/${cleanCode}`);
    const codeSnap = await get(codeRef);

    if (!codeSnap.exists()) {
      return { status: "error", message: "❌ كود الشحن غير صحيح!" };
    }

    const codeData = codeSnap.val();
    if (codeData.isUsed) {
      return { status: "error", message: "⚠️ هذا الكود تم شحنه من قبل!" };
    }

    // جلب رصيد الطالب الحالي
    const stdRef = ref(db, `teacher_students/${cleanTId}/${studentId}`);
    const stdSnap = await get(stdRef);
    if(!stdSnap.exists()) return { status: "error", message: "بيانات الطالب غير موجودة" };
    
    let currentBalance = Number(stdSnap.val().walletBalance || 0);
    let newBalance = currentBalance + Number(codeData.value);

    const updates = {};
    // إغلاق الكود
    updates[`access_codes/${cleanTId}/${cleanCode}/isUsed`] = true;
    updates[`access_codes/${cleanTId}/${cleanCode}/usedByStudentId`] = studentId.toString();
    // شحن رصيد الطالب
    updates[`teacher_students/${cleanTId}/${studentId}/walletBalance`] = newBalance;

    await update(ref(db), updates);
    return { status: "success", addedValue: codeData.value, newBalance: newBalance };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbStudentBuyLesson(studentId, teacherId, lessonId, price) {
  try {
    const cleanTId = teacherId.toString().trim();
    
    // التحقق من رصيد الطالب
    const stdRef = ref(db, `teacher_students/${cleanTId}/${studentId}`);
    const stdSnap = await get(stdRef);
    let currentBalance = Number(stdSnap.val().walletBalance || 0);

    if (currentBalance < price) {
      return { status: "error", message: "رصيد محفظتك لا يكفي لشراء هذه الحصة! يرجى شحن الرصيد أولاً." };
    }

    const lessonRef = ref(db, `content_vault/${cleanTId}/lessons/${lessonId}`);
    const lessonSnap = await get(lessonRef);
    const lesson = lessonSnap.val();
    const unlocked = lesson.unlockedStudents || [];

    if (unlocked.includes(studentId.toString())) {
      return { status: "error", message: "لديك صلاحية لهذه الحصة بالفعل!" };
    }

    unlocked.push(studentId.toString());
    const newBalance = currentBalance - price;

    const updates = {};
    updates[`teacher_students/${cleanTId}/${studentId}/walletBalance`] = newBalance;
    updates[`content_vault/${cleanTId}/lessons/${lessonId}/unlockedStudents`] = unlocked;

    await update(ref(db), updates);
    return { status: "success", newBalance: newBalance };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbDeleteLesson(teacherId, lessonId) {
  try {
    const cleanTId = teacherId.toString().trim();
    await remove(ref(db, `content_vault/${cleanTId}/lessons/${lessonId}`));
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbDeleteExam(teacherId, examId) {
  try {
    const cleanTId = teacherId.toString().trim();
    await remove(ref(db, `content_vault/${cleanTId}/exams/${examId}`));
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}

export async function dbDeleteBook(teacherId, bookId) {
  try {
    const cleanTId = teacherId.toString().trim();
    await remove(ref(db, `content_vault/${cleanTId}/books/${bookId}`));
    return { status: "success" };
  } catch (e) {
    return { status: "error", message: e.toString() };
  }
}


