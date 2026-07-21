// ---------- Admin PIN gate ----------
// The PIN itself lives in Firestore (adminConfig/current) so changing it from
// one device takes effect everywhere, not just that browser. This only
// guards against students accidentally wandering into the roster/edit pages
// — not real security.
const DEFAULT_ADMIN_PIN = "1234";
const ADMIN_UNLOCK_KEY = "kolo_admin_unlocked";

function isAdminUnlocked() {
  return sessionStorage.getItem(ADMIN_UNLOCK_KEY) === "1";
}
function lockAdmin() {
  sessionStorage.removeItem(ADMIN_UNLOCK_KEY);
}
function adminConfigDoc() {
  return db.collection("adminConfig").doc("current");
}
async function loadAdminPin() {
  try {
    const snap = await adminConfigDoc().get();
    return (snap.exists && snap.data().pin) || DEFAULT_ADMIN_PIN;
  } catch (e) {
    console.error("loadAdminPin failed:", e);
    return DEFAULT_ADMIN_PIN;
  }
}
async function saveAdminPin(pin) {
  try {
    await adminConfigDoc().set({ pin });
    return true;
  } catch (e) {
    console.error("saveAdminPin failed:", e);
    return false;
  }
}

// ---------- Student registry & progress storage ----------
// Progress is keyed by sub-lesson id (e.g. "dl-3"), same storage shape works
// whether the id refers to a top-level lesson or a sub-lesson.
const STORAGE_KEY = "kolo_students_v1";
const CURRENT_KEY = "kolo_current_student";

function loadStudents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveStudents(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
function getCurrentStudent() {
  return localStorage.getItem(CURRENT_KEY) || "";
}
function clearCurrentStudent() {
  localStorage.removeItem(CURRENT_KEY);
  localStorage.removeItem(CURRENT_NAME_KEY);
  localStorage.removeItem(UNLOCKED_CACHE_KEY);
}

function loadProgress() {
  const name = getCurrentStudent();
  if (!name) return {};
  const students = loadStudents();
  return students[name] || {};
}
function saveProgress(p) {
  const name = getCurrentStudent();
  if (!name) return;
  const students = loadStudents();
  students[name] = p;
  saveStudents(students);
}
function getLessonProgress(subId) {
  const p = loadProgress();
  return p[subId] || { viewed: false, bestScore: 0, bestTotal: 0, passed: false };
}
function setLessonProgress(subId, patch) {
  const p = loadProgress();
  p[subId] = Object.assign(getLessonProgress(subId), patch);
  saveProgress(p);
}

// ---------- Paid access: accounts & payment proofs ----------
// Real accounts (name + phone + password) live in Firestore, keyed by phone,
// so a student can log in from any device and the admin can see/approve them
// from any device too. This is a lightweight gate appropriate for a small
// paid course, not bank-grade security: this static site has no server of
// its own, so passwords are salted+hashed client-side (not plaintext) but the
// hashing/comparison logic itself is visible in this public JS file, and
// Firestore rules can't distinguish "the real owner" without full Firebase
// Auth. Good enough to keep casual users out; not meant to resist a
// determined attacker with devtools.
const CURRENT_NAME_KEY = "kolo_current_name";
const UNLOCKED_CACHE_KEY = "kolo_unlocked_cache";
const DEFAULT_PAY_AMOUNT_KIP = 20000; // used until the admin sets a real amount in Firestore

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}
function usersCol() {
  return db.collection("users");
}
function paymentProofsCol() {
  return db.collection("paymentProofs");
}
async function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ":" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function findUserByPhone(phone) {
  const id = normalizePhone(phone);
  if (!id) return null;
  try {
    const snap = await usersCol().doc(id).get();
    return snap.exists ? snap.data() : null;
  } catch (e) {
    console.error("findUserByPhone failed:", e);
    return { _offline: true };
  }
}
async function registerUser(name, phone, password) {
  const id = normalizePhone(phone);
  const salt = await randomSalt();
  const passwordHash = await hashPassword(password, salt);
  const user = { name: name.trim(), phone: id, salt, passwordHash, unlocked: false, createdAt: Date.now() };
  await usersCol().doc(id).set(user);
  return user;
}
async function verifyLogin(phone, password) {
  const user = await findUserByPhone(phone);
  if (!user || user._offline) return user || null;
  const hash = await hashPassword(password, user.salt);
  return hash === user.passwordHash ? user : null;
}
async function setUserUnlocked(phone, unlocked) {
  await usersCol().doc(normalizePhone(phone)).update({ unlocked });
}
async function deleteUser(phone) {
  try {
    await usersCol().doc(normalizePhone(phone)).delete();
    return true;
  } catch (e) {
    console.error("deleteUser failed:", e);
    return false;
  }
}
async function loadAllUsers() {
  try {
    const snap = await usersCol().get();
    return snap.docs.map((d) => d.data());
  } catch (e) {
    console.error("loadAllUsers failed:", e);
    return [];
  }
}

function loginSession(phone, name) {
  const id = normalizePhone(phone);
  localStorage.setItem(CURRENT_KEY, id);
  localStorage.setItem(CURRENT_NAME_KEY, name);
  const students = loadStudents();
  if (!students[id]) students[id] = {};
  students[id]._name = name;
  saveStudents(students);
}
function getCurrentStudentName() {
  return localStorage.getItem(CURRENT_NAME_KEY) || "";
}
function getCachedUnlocked() {
  return localStorage.getItem(UNLOCKED_CACHE_KEY) === "1";
}
function setCachedUnlocked(unlocked) {
  localStorage.setItem(UNLOCKED_CACHE_KEY, unlocked ? "1" : "0");
}
async function refreshUnlockedStatus() {
  const phone = getCurrentStudent();
  if (!phone) return false;
  const user = await findUserByPhone(phone);
  if (user && !user._offline) setCachedUnlocked(!!user.unlocked);
  return getCachedUnlocked();
}
function isTopicLocked(topicId) {
  const idx = getTopics().findIndex((t) => t.id === topicId);
  return idx > 0 && !getCachedUnlocked();
}

async function submitPaymentProof(phone, name, imageDataUrl, amount) {
  try {
    await paymentProofsCol().add({
      phone: normalizePhone(phone),
      name,
      imageDataUrl,
      amount,
      status: "pending",
      submittedAt: Date.now(),
    });
    return true;
  } catch (e) {
    console.error("submitPaymentProof failed:", e);
    return false;
  }
}
function paymentSettingsDoc() {
  return db.collection("paymentSettings").doc("current");
}
async function loadPaymentSettings() {
  try {
    const snap = await paymentSettingsDoc().get();
    if (snap.exists) return snap.data();
    return { qrImageDataUrl: null, amount: DEFAULT_PAY_AMOUNT_KIP };
  } catch (e) {
    console.error("loadPaymentSettings failed:", e);
    return { qrImageDataUrl: null, amount: DEFAULT_PAY_AMOUNT_KIP, _offline: true };
  }
}
async function savePaymentSettings(settings) {
  try {
    await paymentSettingsDoc().set(settings);
    return true;
  } catch (e) {
    console.error("savePaymentSettings failed:", e);
    return false;
  }
}
async function loadPaymentProofs() {
  try {
    const snap = await paymentProofsCol().get();
    return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  } catch (e) {
    console.error("loadPaymentProofs failed:", e);
    return [];
  }
}
async function getMyLatestProof(phone) {
  const all = await loadPaymentProofs();
  const mine = all.filter((p) => p.phone === normalizePhone(phone)).sort((a, b) => b.submittedAt - a.submittedAt);
  return mine[0] || null;
}
async function approveProof(proofId, phone) {
  const id = normalizePhone(phone);
  if (!id) {
    console.error("approveProof failed: proof has no valid phone attached", proofId);
    return { ok: false, reason: "no-phone" };
  }
  try {
    // Unlock the student FIRST — if this throws, the proof stays "pending"
    // instead of getting marked "approved" while the student never actually
    // gets unlocked (a silent partial-failure that looked like nothing
    // happened, but had actually half-happened).
    await setUserUnlocked(id, true);
    await paymentProofsCol().doc(proofId).update({ status: "approved", reviewedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error("approveProof failed:", e);
    return { ok: false, reason: "error" };
  }
}
async function rejectProof(proofId) {
  try {
    await paymentProofsCol().doc(proofId).update({ status: "rejected", reviewedAt: Date.now() });
    return true;
  } catch (e) {
    console.error("rejectProof failed:", e);
    return false;
  }
}
// Resize/compress an uploaded image client-side so the base64 stored in the
// Firestore document (no Storage bucket needed) stays well under its 1MB cap.
function readImageAsCompressedDataUrl(file, maxWidth = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// QR codes are dense fine-grained patterns — lossy JPEG compression can
// destroy scannability, so this keeps PNG (lossless) and only downsizes
// the canvas if the source is unnecessarily huge.
function readImageAsLosslessDataUrl(file, maxWidth = 700) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Lesson content overrides (admin edits, keyed by sub-lesson id) ----------
const CONTENT_KEY = "kolo_content_overrides_v1";

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(CONTENT_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveOverrides(o) {
  localStorage.setItem(CONTENT_KEY, JSON.stringify(o));
}

function flattenLesson(lesson) {
  const flat = [];
  lesson.sections.forEach((sec) => {
    sec.items.forEach((item, idx) => {
      flat.push(Object.assign({}, item, {
        section_lo: idx === 0 ? sec.title_lo || null : null,
        section_ko: idx === 0 ? sec.title_ko || null : null,
      }));
    });
  });
  return flat;
}

function groupIntoSections(flatItems) {
  const sections = [];
  let current = null;
  flatItems.forEach((raw) => {
    const { section_lo, section_ko, ...rest } = raw;
    if (section_lo && (!current || current.title_lo !== section_lo)) {
      current = { title_lo: section_lo, title_ko: section_ko || "", items: [] };
      sections.push(current);
    } else if (!current) {
      current = { title_lo: null, title_ko: null, items: [] };
      sections.push(current);
    }
    current.items.push(rest);
  });
  return sections;
}

// ---------- Topic / sub-lesson data access ----------
function getTopics() {
  const overrides = loadOverrides();
  return LESSONS.map((topic) => ({
    id: topic.id,
    icon: topic.icon,
    title_lo: topic.title_lo,
    title_ko: topic.title_ko,
    subLessons: topic.subLessons.map((sub) => {
      const ov = overrides[sub.id];
      const merged = !ov ? sub : {
        id: sub.id,
        icon: ov.icon != null && ov.icon !== "" ? ov.icon : sub.icon,
        title_lo: ov.title_lo != null && ov.title_lo !== "" ? ov.title_lo : sub.title_lo,
        title_ko: ov.title_ko != null && ov.title_ko !== "" ? ov.title_ko : sub.title_ko,
        sections: groupIntoSections(ov.flatItems),
      };
      return Object.assign({}, merged, {
        topicId: topic.id,
        topicTitle_lo: topic.title_lo,
        topicIcon: topic.icon,
      });
    }),
  }));
}

function getAllSubLessons() {
  return getTopics().flatMap((t) => t.subLessons);
}

function findTopic(topicId) {
  return getTopics().find((t) => t.id === topicId);
}
function findLesson(subId) {
  return getAllSubLessons().find((s) => s.id === subId);
}
function allItems(lesson) {
  return lesson.sections.flatMap((s) => s.items);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Official exam (separate from practice quizzes) ----------
// Backed by Firestore (shared cloud database, see firebase-config.js) instead of
// localStorage, so the enable/disable toggle, the 30-question bank, and every
// submitted result are visible to ALL devices at once — required so many workers
// can sign in and take the exam at the same time from their own phone/tablet/PC.
const EXAM_TAKER_KEY = "kolo_exam_current_taker"; // stays local: "who is sitting at this device right now"

function examConfigDoc() {
  return db.collection("examConfig").doc("current");
}
function examResultsCol() {
  return db.collection("examResults");
}

async function loadExamConfig() {
  try {
    const snap = await examConfigDoc().get();
    if (snap.exists) return snap.data();
    return { enabled: false, questions: [] };
  } catch (e) {
    console.error("loadExamConfig failed:", e);
    return { enabled: false, questions: [], _offline: true };
  }
}
async function saveExamConfig(cfg) {
  try {
    await examConfigDoc().set(cfg);
    return true;
  } catch (e) {
    console.error("saveExamConfig failed:", e);
    await showAlert("ບໍ່ສາມາດບັນທຶກໄດ້ (ກວດສອບການເຊື່ອມຕໍ່ອິນເຕີເນັດ)");
    return false;
  }
}
function generateExamQuestions(count) {
  const pool = getAllSubLessons().flatMap(allItems).filter((it) => it.korean && it.lao_meaning);
  return shuffle(pool).slice(0, Math.min(count, pool.length)).map((it) => ({
    korean: it.korean,
    lao_phonetic: it.lao_phonetic,
    lao_meaning: it.lao_meaning,
  }));
}
function getCurrentExamTaker() {
  return sessionStorage.getItem(EXAM_TAKER_KEY) || "";
}
function setCurrentExamTaker(name) {
  sessionStorage.setItem(EXAM_TAKER_KEY, name.trim());
}
function clearCurrentExamTaker() {
  sessionStorage.removeItem(EXAM_TAKER_KEY);
}
async function loadExamResults() {
  try {
    const snap = await examResultsCol().get();
    return snap.docs.map((d) => d.data());
  } catch (e) {
    console.error("loadExamResults failed:", e);
    return [];
  }
}
async function addExamResult(name, score, total) {
  try {
    await examResultsCol().add({ name: name.trim(), score, total, timestamp: Date.now() });
    return true;
  } catch (e) {
    console.error("addExamResult failed:", e);
    await showAlert("ບໍ່ສາມາດບັນທຶກຄະແນນໄດ້ (ກວດສອບການເຊື່ອມຕໍ່ອິນເຕີເນັດ) — ລອງໃໝ່ອີກຄັ້ງ");
    return false;
  }
}

// ---------- Text to speech ----------
// Two voices: Korean (so students hear how vocabulary sounds) and Lao (so a
// Korean employer who can't read Lao script can still play the Lao meaning
// out loud to a worker). Lao TTS voices are not present on every device/OS —
// speakLao() degrades gracefully with a message when none is found.
let koreanVoice = null;
let laoVoice = null;
const NOVELTY_VOICE_RE = /grandma|grandpa|eddy|reed|rocko|sandy|shelley|flo|jester|bahh|bells|boing|bubbles|organ|trinoids|whisper|zarvox|albert|bad news|good news|superstar|wobble|deranged|cellos|hysterical/i;
function pickVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const koVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ko"));
  if (!koVoices.length) {
    koreanVoice = null;
    return;
  }
  const scored = koVoices.map((v) => {
    let score = 0;
    if (/yuna/i.test(v.name)) score += 10;
    if (v.default) score += 3;
    if (v.localService) score += 2;
    if (NOVELTY_VOICE_RE.test(v.name)) score -= 5;
    return { v, score };
  });
  scored.sort((a, b) => b.score - a.score);
  koreanVoice = scored[0].v;
}
function pickLaoVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const loVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("lo"));
  laoVoice = loVoices[0] || null;
}
function refreshVoices() {
  pickVoice();
  pickLaoVoice();
}
if (window.speechSynthesis) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}
function speak(text) {
  if (!window.speechSynthesis) return;
  if (!koreanVoice) pickVoice();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  if (koreanVoice) u.voice = koreanVoice;
  u.rate = 0.8;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}
function speakLao(text) {
  if (!window.speechSynthesis) return;
  if (!laoVoice) pickLaoVoice();
  if (!laoVoice) {
    showAlert("ອຸປະກອນນີ້ບໍ່ມີສຽງອ່ານພາສາລາວ. ກະລຸນາໃຫ້ນາຍຈ້າງອ່ານຄວາມໝາຍທີ່ສະແດງໄວ້ແທນ, ຫຼືລອງໃຊ້ອຸປະກອນອື່ນ.");
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = laoVoice.lang;
  u.voice = laoVoice;
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}

// ---------- Custom modal (replaces native confirm()/alert()) ----------
// Facebook/Messenger/LINE's built-in browser — how many workers actually open
// a link shared in a chat — silently blocks or auto-dismisses native
// confirm()/alert() dialogs. When that happens `if (!confirm(...)) return;`
// exits immediately and a button click looks like it did nothing at all, even
// though the underlying save succeeded. This in-page modal has no such issue.
function showModal(message, { showCancel } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-message">${message}</div>
        <div class="modal-actions">
          ${showCancel ? '<button class="btn-secondary modal-cancel-btn">ຍົກເລີກ</button>' : ""}
          <button class="btn-primary modal-ok-btn">${showCancel ? "ຢືນຢັນ" : "ຕົກລົງ"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (result) => {
      document.body.removeChild(overlay);
      resolve(result);
    };
    overlay.querySelector(".modal-ok-btn").addEventListener("click", () => cleanup(true));
    const cancelBtn = overlay.querySelector(".modal-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => cleanup(false));
  });
}
function showConfirm(message) {
  return showModal(message, { showCancel: true });
}
function showAlert(message) {
  return showModal(message, { showCancel: false });
}

// ---------- Router ----------
const app = document.getElementById("app");
const topTitle = document.getElementById("topTitle");
const backBtn = document.getElementById("backBtn");
const studentBtn = document.getElementById("studentBtn");
const searchBtn = document.getElementById("searchBtn");

function navigate(hash) {
  window.location.hash = hash;
}
backBtn.addEventListener("click", () => {
  const parts = currentRoute();
  if (parts.view === "topic" || parts.view === "students") return navigate("#/home");
  if (parts.view === "lesson") {
    const sub = findLesson(parts.id);
    return navigate(sub ? "#/topic/" + sub.topicId : "#/home");
  }
  if (parts.view === "quiz") return navigate("#/lesson/" + parts.id);
  if (parts.view === "result") return navigate("#/lesson/" + parts.id);
  if (parts.view === "edit" || parts.view === "examedit") return navigate("#/students");
  if (parts.view === "examquiz" || parts.view === "examresult") return navigate("#/examname");
  navigate("#/home");
});
studentBtn.addEventListener("click", async () => {
  if (await showConfirm("ອອກຈາກລະບົບບໍ?")) {
    clearCurrentStudent();
    navigate("#/name");
  }
});
searchBtn.addEventListener("click", () => navigate("#/search"));

function currentRoute() {
  const hash = window.location.hash.replace(/^#\//, "");
  const parts = hash.split("/");
  if (parts[0] === "name") return { view: "name" };
  if (parts[0] === "search") return { view: "search" };
  if (parts[0] === "paywall") return { view: "paywall" };
  if (parts[0] === "students") return { view: "students" };
  if (parts[0] === "edit") return { view: "edit", id: parts[1] };
  if (parts[0] === "examedit") return { view: "examedit" };
  if (parts[0] === "examname") return { view: "examname" };
  if (parts[0] === "examquiz") return { view: "examquiz" };
  if (parts[0] === "examresult") return { view: "examresult", score: parts[1], total: parts[2] };
  if (parts[0] === "topic") return { view: "topic", id: parts[1] };
  if (parts[0] === "lesson") return { view: "lesson", id: parts[1] };
  if (parts[0] === "quiz") return { view: "quiz", id: parts[1] };
  if (parts[0] === "result") return { view: "result", id: parts[1], score: parts[2], total: parts[3] };
  return { view: "home" };
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", () => {
  if (!window.location.hash) navigate(getCurrentStudent() ? "#/home" : "#/name");
  render();
});

function render() {
  const route = currentRoute();
  window.scrollTo(0, 0);

  const needsStudent = ["home", "topic", "lesson", "quiz", "result", "search", "paywall"].includes(route.view);
  if (needsStudent && !getCurrentStudent()) return navigate("#/name");

  const needsAdmin = route.view === "students" || route.view === "edit" || route.view === "examedit";
  if (needsAdmin && !isAdminUnlocked()) return renderAdminGate(window.location.hash || "#/students");

  updateStudentBadge(route.view);

  if (route.view === "name") return renderNameEntry();
  if (route.view === "search") return renderSearch();
  if (route.view === "paywall") return renderPaywall();
  if (route.view === "students") return renderStudents();
  if (route.view === "edit") return renderEdit(route.id);
  if (route.view === "examedit") return renderExamEdit();
  if (route.view === "examname") return renderExamNameEntry();
  if (route.view === "examquiz") return renderExamQuiz();
  if (route.view === "examresult") return renderExamResult(Number(route.score), Number(route.total));
  if (route.view === "topic") return renderTopic(route.id);
  if (route.view === "home") return renderHome();
  if (route.view === "lesson") return renderLesson(route.id);
  if (route.view === "quiz") return renderQuiz(route.id);
  if (route.view === "result") return renderResult(route.id, Number(route.score), Number(route.total));
  renderHome();
}

const EXAM_VIEWS = ["examname", "examquiz", "examresult", "examedit"];
function updateStudentBadge(view) {
  const phone = getCurrentStudent();
  const loggedIn = view !== "name" && !EXAM_VIEWS.includes(view) && !!phone;
  studentBtn.classList.toggle("hidden", !loggedIn);
  searchBtn.classList.toggle("hidden", !loggedIn || view === "search");
  if (loggedIn) studentBtn.textContent = "👤 " + (getCurrentStudentName() || phone);
}

// ---------- Register / login view ----------
let authMode = "register";
function renderNameEntry() {
  backBtn.classList.toggle("hidden", !getCurrentStudent());
  topTitle.textContent = "ເຂົ້າສູ່ລະບົບ";

  app.innerHTML = `
    <div class="intro">
      <h2>ຍິນດີຕ້ອນຮັບ 🙋</h2>
      <p>ຫົວຂໍ້ທຳອິດ (ການທັກທາຍ) ຮຽນໄດ້ຟຣີ. ຫົວຂໍ້ອື່ນໆຕ້ອງລົງທະບຽນ ແລະ ຊຳລະເງິນກ່ອນຈຶ່ງຮຽນໄດ້.</p>
    </div>
    <div class="auth-tabs">
      <button class="auth-tab" id="tabRegister">ລົງທະບຽນໃໝ່</button>
      <button class="auth-tab" id="tabLogin">ເຂົ້າສູ່ລະບົບ</button>
    </div>
    <div id="authForm"></div>
    <div id="authError" class="admin-pin-error"></div>
    <button class="link-btn" id="examLinkBtn">📝 ລົງຊື່ເຂົ້າສອບເສັງ (ສະເພາະສອບເສັງທາງການ)</button>
    <button class="link-btn" id="rosterLinkBtn">📋 ລາຍຊື່ນັກຮຽນ ແລະ ຄະແນນ (ສຳລັບຄູ/ແອັດມິນ)</button>
  `;

  document.getElementById("tabRegister").addEventListener("click", () => { authMode = "register"; renderNameEntry(); });
  document.getElementById("tabLogin").addEventListener("click", () => { authMode = "login"; renderNameEntry(); });
  document.getElementById("examLinkBtn").addEventListener("click", () => navigate("#/examname"));
  document.getElementById("rosterLinkBtn").addEventListener("click", () => navigate("#/students"));

  document.getElementById("tabRegister").classList.toggle("active", authMode === "register");
  document.getElementById("tabLogin").classList.toggle("active", authMode === "login");

  const errorEl = document.getElementById("authError");
  const formEl = document.getElementById("authForm");

  if (authMode === "register") {
    formEl.innerHTML = `
      <label class="field-label" for="regName">ຊື່ ແລະ ນາມສະກຸນ</label>
      <input id="regName" class="name-input" type="text" placeholder="ຂຽນຊື່ຂອງທ່ານທີ່ນີ້..." autocomplete="off" />
      <label class="field-label" for="regPhone">ເບີໂທ</label>
      <input id="regPhone" class="name-input" type="tel" inputmode="numeric" placeholder="ຂຽນເບີໂທຂອງທ່ານ..." autocomplete="off" />
      <label class="field-label" for="regPass">ລະຫັດຜ່ານ</label>
      <input id="regPass" class="name-input" type="password" placeholder="ຢ່າງໜ້ອຍ 4 ໂຕ..." autocomplete="off" />
      <label class="field-label" for="regPass2">ຢືນຢັນລະຫັດຜ່ານ</label>
      <input id="regPass2" class="name-input" type="password" placeholder="ພິມລະຫັດຜ່ານອີກຄັ້ງ..." autocomplete="off" />
      <button class="btn-primary" id="authSubmitBtn">ລົງທະບຽນ →</button>
    `;
    const submit = async () => {
      errorEl.textContent = "";
      const name = document.getElementById("regName").value.trim();
      const phone = normalizePhone(document.getElementById("regPhone").value);
      const pass = document.getElementById("regPass").value;
      const pass2 = document.getElementById("regPass2").value;
      if (!name || phone.length < 8 || !pass) {
        errorEl.textContent = "ກະລຸນາຂຽນຊື່, ເບີໂທ (ຢ່າງໜ້ອຍ 8 ໂຕເລກ), ແລະ ລະຫັດຜ່ານໃຫ້ຄົບ";
        return;
      }
      if (pass.length < 4) {
        errorEl.textContent = "ລະຫັດຜ່ານຕ້ອງມີຢ່າງໜ້ອຍ 4 ໂຕ";
        return;
      }
      if (pass !== pass2) {
        errorEl.textContent = "ລະຫັດຜ່ານທັງສອງຊ່ອງບໍ່ຄືກັນ";
        return;
      }
      const btn = document.getElementById("authSubmitBtn");
      btn.disabled = true;
      btn.textContent = "ກຳລັງລົງທະບຽນ...";
      const existing = await findUserByPhone(phone);
      if (existing && existing._offline) {
        errorEl.textContent = "ເຊື່ອມຕໍ່ຖານຂໍ້ມູນບໍ່ໄດ້ (ກວດສອບອິນເຕີເນັດ)";
        btn.disabled = false;
        btn.textContent = "ລົງທະບຽນ →";
        return;
      }
      if (existing) {
        errorEl.textContent = "ເບີໂທນີ້ລົງທະບຽນແລ້ວ, ກະລຸນາເຂົ້າສູ່ລະບົບແທນ";
        btn.disabled = false;
        btn.textContent = "ລົງທະບຽນ →";
        return;
      }
      const user = await registerUser(name, phone, pass);
      loginSession(user.phone, user.name);
      setCachedUnlocked(false);
      navigate("#/home");
    };
    document.getElementById("authSubmitBtn").addEventListener("click", submit);
  } else {
    formEl.innerHTML = `
      <label class="field-label" for="loginPhone">ເບີໂທ</label>
      <input id="loginPhone" class="name-input" type="tel" inputmode="numeric" placeholder="ຂຽນເບີໂທຂອງທ່ານ..." autocomplete="off" />
      <label class="field-label" for="loginPass">ລະຫັດຜ່ານ</label>
      <input id="loginPass" class="name-input" type="password" placeholder="ຂຽນລະຫັດຜ່ານ..." autocomplete="off" />
      <button class="btn-primary" id="authSubmitBtn">ເຂົ້າສູ່ລະບົບ →</button>
    `;
    const submit = async () => {
      errorEl.textContent = "";
      const phone = normalizePhone(document.getElementById("loginPhone").value);
      const pass = document.getElementById("loginPass").value;
      if (!phone || !pass) {
        errorEl.textContent = "ກະລຸນາຂຽນເບີໂທ ແລະ ລະຫັດຜ່ານ";
        return;
      }
      const btn = document.getElementById("authSubmitBtn");
      btn.disabled = true;
      btn.textContent = "ກຳລັງກວດສອບ...";
      const user = await verifyLogin(phone, pass);
      if (user && user._offline) {
        errorEl.textContent = "ເຊື່ອມຕໍ່ຖານຂໍ້ມູນບໍ່ໄດ້ (ກວດສອບອິນເຕີເນັດ)";
        btn.disabled = false;
        btn.textContent = "ເຂົ້າສູ່ລະບົບ →";
        return;
      }
      if (!user) {
        errorEl.textContent = "ເບີໂທ ຫຼື ລະຫັດຜ່ານບໍ່ຖືກຕ້ອງ";
        btn.disabled = false;
        btn.textContent = "ເຂົ້າສູ່ລະບົບ →";
        return;
      }
      loginSession(user.phone, user.name);
      setCachedUnlocked(!!user.unlocked);
      navigate("#/home");
    };
    document.getElementById("authSubmitBtn").addEventListener("click", submit);
  }
}

// ---------- Admin PIN gate ----------
function renderAdminGate(targetHash) {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ສຳລັບແອັດມິນ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderAdminGateAsync(targetHash);
}
async function renderAdminGateAsync(targetHash) {
  const currentPin = await loadAdminPin();

  app.innerHTML = `
    <div class="intro edit-intro">
      <h2>🔒 ໜ້ານີ້ສຳລັບແອັດມິນ</h2>
      <p>ກະລຸນາໃສ່ລະຫັດ PIN ເພື່ອເຂົ້າໜ້າລາຍຊື່ນັກຮຽນ ແລະ ແກ້ໄຂບົດຮຽນ.</p>
    </div>
    <input id="adminPinInput" class="name-input" type="password" inputmode="numeric" placeholder="ໃສ່ລະຫັດ PIN..." autocomplete="off" />
    <button class="btn-primary" id="adminPinBtn">ເຂົ້າສູ່ລະບົບ →</button>
    <div id="adminPinError" class="admin-pin-error"></div>
  `;

  const input = document.getElementById("adminPinInput");
  const tryUnlock = () => {
    if (input.value === currentPin) {
      sessionStorage.setItem(ADMIN_UNLOCK_KEY, "1");
      if (window.location.hash === targetHash) render();
      else navigate(targetHash);
    } else {
      document.getElementById("adminPinError").textContent = "ລະຫັດບໍ່ຖືກຕ້ອງ, ລອງໃໝ່ອີກຄັ້ງ";
      input.value = "";
      input.focus();
    }
  };
  document.getElementById("adminPinBtn").addEventListener("click", tryUnlock);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryUnlock();
  });
  input.focus();
}

// ---------- Student roster (admin) view ----------
function renderStudents() {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ລາຍຊື່ນັກຮຽນ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderStudentsAsync();
}

async function renderStudentsAsync() {
  const topics = getTopics();
  const students = loadStudents();
  const names = Object.keys(students).sort((a, b) => a.localeCompare(b, "lo"));

  const rows = names.map((name) => {
    const prog = students[name] || {};
    const topicBadges = topics.map((topic) => {
      const subs = topic.subLessons;
      const passedCount = subs.filter((s) => prog[s.id] && prog[s.id].passed).length;
      const anyStarted = subs.some((s) => prog[s.id] && (prog[s.id].viewed || prog[s.id].bestTotal));
      let cls = "not-started";
      if (passedCount === subs.length) cls = "passed";
      else if (passedCount > 0) cls = "in-progress";
      else if (anyStarted) cls = "in-progress";
      return `<span class="mini-badge ${cls}" title="${topic.title_lo}: ${passedCount}/${subs.length} ຜ່ານ">${topic.icon} ${passedCount}/${subs.length}</span>`;
    }).join("");
    const totalSubs = topics.reduce((n, t) => n + t.subLessons.length, 0);
    const totalPassed = topics.reduce((n, t) => n + t.subLessons.filter((s) => prog[s.id] && prog[s.id].passed).length, 0);
    return `
      <div class="roster-row">
        <div class="roster-name">${name}</div>
        <div class="roster-badges">${topicBadges}</div>
        <div class="roster-summary">${totalPassed}/${totalSubs} ບົດຜ່ານ</div>
        <button class="roster-delete-btn" data-name="${escapeAttr(name)}" aria-label="ລຶບ">🗑️</button>
      </div>`;
  }).join("");

  const editSections = topics.map((topic) => `
    <details class="edit-topic-group">
      <summary class="edit-topic-title">${topic.icon} ${topic.title_lo}</summary>
      <div class="edit-links">
        ${topic.subLessons.map((s) => `<button class="lesson-edit-btn" data-id="${s.id}">✏️ ${s.title_lo}</button>`).join("")}
      </div>
    </details>
  `).join("");

  const allUsers = await loadAllUsers();
  const allProofs = await loadPaymentProofs();
  const paySettings = await loadPaymentSettings();
  const currentAdminPin = await loadAdminPin();
  const pendingProofs = allProofs
    .filter((p) => p.status === "pending")
    .sort((a, b) => a.submittedAt - b.submittedAt);
  const usersByPhone = Object.fromEntries(allUsers.map((u) => [u.phone, u]));

  const pendingProofsHtml = pendingProofs.length
    ? pendingProofs.map((p) => {
        const user = usersByPhone[p.phone];
        const date = new Date(p.submittedAt).toLocaleString("lo-LA");
        return `
        <div class="proof-row">
          <img class="proof-thumb" src="${p.imageDataUrl}" alt="ຫຼັກຖານ" data-full="${p.imageDataUrl}" />
          <div class="proof-info">
            <div class="roster-name">${p.name || (user && user.name) || p.phone}</div>
            <div class="roster-summary">📞 ${p.phone} · ${date}</div>
          </div>
          <div class="proof-actions">
            <button class="btn-secondary approve-proof-btn" data-id="${p.id}" data-phone="${p.phone}">✅ ອະນຸມັດ</button>
            <button class="btn-secondary reject-proof-btn" data-id="${p.id}">❌ ປະຕິເສດ</button>
          </div>
        </div>`;
      }).join("")
    : '<div class="empty-msg">ບໍ່ມີການລໍຖ້າກວດສອບ</div>';

  const usersHtml = allUsers.length
    ? allUsers
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "lo"))
        .map((u) => `
        <div class="roster-row">
          <div class="roster-name">${u.name}</div>
          <div class="roster-summary">📞 ${u.phone}</div>
          <button class="btn-secondary toggle-unlock-btn" data-phone="${u.phone}" data-unlocked="${u.unlocked ? "1" : "0"}">
            ${u.unlocked ? "🔓 ປົດລ໋ອກແລ້ວ (ກົດເພື່ອລ໋ອກ)" : "🔒 ຍັງລ໋ອກ (ກົດເພື່ອປົດລ໋ອກ)"}
          </button>
          <button class="btn-secondary btn-danger delete-user-btn" data-phone="${u.phone}" data-name="${escapeAttr(u.name)}">🗑️ ລຶບບັນຊີນີ້</button>
        </div>`).join("")
    : '<div class="empty-msg">ຍັງບໍ່ມີບັນຊີລົງທະບຽນ</div>';

  const examCfg = await loadExamConfig();
  const examResultsRaw = await loadExamResults();
  const examResults = examResultsRaw
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "lo") || a.timestamp - b.timestamp);
  const examResultsHtml = examResults.length
    ? examResults.map((r) => {
        const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
        const passed = pct >= 70;
        const date = new Date(r.timestamp).toLocaleString("lo-LA");
        return `
        <div class="roster-row">
          <div class="roster-name">${r.name}</div>
          <div class="roster-summary">${date}</div>
          <span class="badge ${passed ? "passed" : "failed"}">${r.score}/${r.total}</span>
        </div>`;
      }).join("")
    : '<div class="empty-msg">ຍັງບໍ່ມີຄົນສອບເສັງ</div>';

  const offlineNotice = examCfg._offline
    ? `<p class="admin-hint" style="color:var(--red);">⚠️ ເຊື່ອມຕໍ່ຖານຂໍ້ມູນກາງບໍ່ໄດ້ — ກວດສອບອິນເຕີເນັດ. ການຕັ້ງຄ່າສອບເສັງອາດບໍ່ທັນສະໄໝ.</p>`
    : "";

  app.innerHTML = `
    <div class="intro">
      <h2>ລາຍຊື່ນັກຮຽນ 📋</h2>
      <p>ຮ່ວມທັງໝົດ ${names.length} ຄົນ (ລຽງຕາມຕົວອັກສອນ). ໄອຄອນສີຂຽວ = ຜ່ານໝົດ, ສີເຫຼືອງ = ກຳລັງຮຽນ, ສີເທົາ = ຍັງບໍ່ໄດ້ຮຽນ.</p>
    </div>
    ${names.length ? `<div class="roster-list">${rows}</div>` : '<div class="empty-msg">ຍັງບໍ່ມີນັກຮຽນລົງທະບຽນ</div>'}

    <div class="admin-tools">
      <h3>⚙️ ຕັ້ງຄ່າການຊຳລະເງິນ</h3>
      <p class="admin-hint">ອັບໂຫລດຮູບ QR ໂອນເງິນ ແລະ ກຳນົດຈຳນວນຄ່າທຳນຽມ. ບັນທຶກແລ້ວຈະສະແດງໃນໜ້າຊຳລະເງິນຂອງນັກຮຽນທັນທີ.</p>
      ${paySettings.qrImageDataUrl ? `<img class="qr-image" id="currentQrPreview" src="${paySettings.qrImageDataUrl}" alt="QR ປັດຈຸບັນ" style="display:block;margin-bottom:14px;" />` : '<p class="admin-hint">ຍັງບໍ່ໄດ້ຕັ້ງຄ່າ QR</p>'}
      <label class="field-label" for="qrUploadInput">ຮູບ QR ໂອນເງິນໃໝ່ (ຖ້າຢາກປ່ຽນ)</label>
      <input type="file" id="qrUploadInput" accept="image/*" class="name-input" />
      <label class="field-label" for="paySettingsAmount">ຈຳນວນເງິນ (ກີບ)</label>
      <input type="number" id="paySettingsAmount" class="name-input" value="${paySettings.amount}" min="0" step="1000" />
      <button class="btn-secondary" id="savePaySettingsBtn">💾 ບັນທຶກການຕັ້ງຄ່າ</button>
      <div id="paySettingsMsg" class="admin-hint"></div>
    </div>

    <div class="admin-tools">
      <h3>💳 ອະນຸມັດການຊຳລະເງິນ (${pendingProofs.length} ລໍຖ້າ)</h3>
      <p class="admin-hint">ກວດຮູບຫຼັກຖານການໂອນເງິນ ${paySettings.amount.toLocaleString("en-US")} ກີບ ແລ້ວກົດອະນຸມັດ ຫຼື ປະຕິເສດ. ອະນຸມັດແລ້ວຈະປົດລ໋ອກທຸກຫົວຂໍ້ໃຫ້ຄົນນັ້ນທັນທີ.</p>
      <div class="roster-list">${pendingProofsHtml}</div>
    </div>

    <div class="admin-tools">
      <h3>👤 ບັນຊີນັກຮຽນ (${allUsers.length} ຄົນ)</h3>
      <p class="admin-hint">ກົດປຸ່ມເພື່ອລ໋ອກ/ປົດລ໋ອກທຸກຫົວຂໍ້ໃຫ້ຄົນນັ້ນດ້ວຍຕົນເອງ (ນອກເໜືອຈາກການອະນຸມັດການຊຳລະເງິນຂ້າງເທິງ).</p>
      <div class="roster-list">${usersHtml}</div>
    </div>

    <div class="admin-tools">
      <h3>✏️ ແກ້ໄຂບົດຮຽນ</h3>
      <p class="admin-hint">ເລືອກບົດຮຽນຍ່ອຍເພື່ອແກ້ໄຂ, ເພີ່ມ, ຫຼືລຶບຄຳສັບ/ປະໂຫຍກ.</p>
      ${editSections}
    </div>

    <div class="admin-tools">
      <h3>📝 ຈັດການບົດສອບເສັງທາງການ</h3>
      <p class="admin-hint">ບົດສອບເສັງນີ້ແຍກຕ່າງຫາກຈາກແບບທົດສອບຝຶກຫັດປົກກະຕິ — ໃຊ້ 30 ຂໍ້ ສຸ່ມຈາກທຸກບົດ. ເປີດສະເພາະຍາມທີ່ຈະສອບເສັງແທ້ໆ. ຕັ້ງຄ່ານີ້ນຳໃຊ້ຮ່ວມກັນທຸກອຸປະກອນຜ່ານອິນເຕີເນັດ.</p>
      ${offlineNotice}
      <button class="btn-secondary" id="toggleExamBtn">${examCfg.enabled ? "🔴 ປິດຮັບລົງທະບຽນສອບເສັງ" : "🟢 ເປີດຮັບລົງທະບຽນສອບເສັງ"}</button>
      <button class="btn-secondary" id="regenExamBtn">🎲 ສຸ່ມຄຳຖາມ 30 ຂໍ້ໃໝ່</button>
      <button class="btn-secondary" id="editExamBtn">✏️ ແກ້ໄຂຄຳຖາມສອບເສັງ (${examCfg.questions.length} ຂໍ້)</button>
    </div>

    <div class="admin-tools">
      <h3>🏆 ຜົນສອບເສັງທາງການ</h3>
      <div class="roster-list">${examResultsHtml}</div>
    </div>

    <div class="admin-tools">
      <h3>💾 ສຳຮອງ ແລະ ນຳໃຊ້ຂໍ້ມູນ</h3>
      <p class="admin-hint">ຫຼັງຈາກແກ້ໄຂແລ້ວ, ດາວໂຫຼດ data.js ແລ້ວນຳໄປແທນທີ່ໄຟລ໌ເກົ່າໃນໂຟລເດີເວັບໄຊ ເພື່ອໃຫ້ນັກຮຽນທຸກຄົນເຫັນການປ່ຽນແປງຖາວອນ.</p>
      <div class="admin-io">
        <button class="btn-secondary" id="exportDataBtn">⬇️ ດາວໂຫຼດ data.js</button>
        <button class="btn-secondary" id="exportBackupBtn">⬇️ ດາວໂຫຼດ Backup</button>
        <label class="btn-secondary import-label">⬆️ ນຳເຂົ້າ Backup
          <input type="file" id="importInput" accept="application/json" hidden />
        </label>
      </div>
    </div>

    <div class="admin-tools">
      <h3>🔑 ປ່ຽນລະຫັດ PIN ແອັດມິນ</h3>
      <p class="admin-hint">ລະຫັດນີ້ໃຊ້ຮ່ວມກັນທຸກອຸປະກອນ — ປ່ຽນຈາກເຄື່ອງນີ້ແລ້ວ ໃຊ້ໄດ້ທຸກບ່ອນທັນທີ.</p>
      <label class="field-label" for="curPinInput">ລະຫັດ PIN ປັດຈຸບັນ</label>
      <input type="password" id="curPinInput" class="name-input" inputmode="numeric" autocomplete="off" />
      <label class="field-label" for="newPinInput">ລະຫັດ PIN ໃໝ່</label>
      <input type="password" id="newPinInput" class="name-input" inputmode="numeric" autocomplete="off" />
      <label class="field-label" for="newPinInput2">ຢືນຢັນລະຫັດ PIN ໃໝ່</label>
      <input type="password" id="newPinInput2" class="name-input" inputmode="numeric" autocomplete="off" />
      <button class="btn-secondary" id="changePinBtn">💾 ບັນທຶກລະຫັດໃໝ່</button>
      <div id="changePinMsg" class="admin-hint"></div>
    </div>

    <button class="link-btn" id="lockAdminBtn">🔒 ອອກຈາກໂໝດແອັດມິນ</button>
  `;

  app.querySelectorAll(".lesson-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigate("#/edit/" + btn.dataset.id));
  });
  app.querySelectorAll(".roster-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await showConfirm(`ລຶບຄວາມຄືບໜ້າຂອງ "${btn.dataset.name}" ອອກຈາກລາຍຊື່ນີ້ບໍ? (ອັນນີ້ແມ່ນຂໍ້ມູນຄວາມຄືບໜ້າໃນອຸປະກອນນີ້ເທົ່ານັ້ນ, ບໍ່ກ່ຽວກັບບັນຊີເຂົ້າສູ່ລະບົບ)`);
      if (!ok) return;
      const students = loadStudents();
      delete students[btn.dataset.name];
      saveStudents(students);
      renderStudentsAsync();
    });
  });
  app.querySelectorAll(".proof-thumb").forEach((img) => {
    img.addEventListener("click", () => window.open(img.dataset.full, "_blank"));
  });
  app.querySelectorAll(".approve-proof-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await showConfirm("ອະນຸມັດການຊຳລະເງິນນີ້ ແລະ ປົດລ໋ອກທຸກຫົວຂໍ້ໃຫ້ບໍ?"))) return;
      btn.disabled = true;
      const result = await approveProof(btn.dataset.id, btn.dataset.phone);
      if (!result.ok) {
        const msg = result.reason === "no-phone"
          ? "ຫຼັກຖານນີ້ບໍ່ມີເບີໂທຂອງນັກຮຽນຕິດມາ (ອາດແມ່ນຂໍ້ມູນເກົ່າຜິດພາດ) — ອະນຸມັດບໍ່ໄດ້, ກະລຸນາປະຕິເສດອັນນີ້ແທນ"
          : "ອະນຸມັດບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່";
        await showAlert(msg);
      }
      renderStudentsAsync();
    });
  });
  app.querySelectorAll(".reject-proof-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!(await showConfirm("ປະຕິເສດຫຼັກຖານນີ້ບໍ? ນັກຮຽນຈະສາມາດອັບໂຫລດໃໝ່ໄດ້."))) return;
      btn.disabled = true;
      const ok = await rejectProof(btn.dataset.id);
      if (!ok) await showAlert("ປະຕິເສດບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່");
      renderStudentsAsync();
    });
  });
  app.querySelectorAll(".toggle-unlock-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextUnlocked = btn.dataset.unlocked !== "1";
      btn.disabled = true;
      try {
        await setUserUnlocked(btn.dataset.phone, nextUnlocked);
      } catch (e) {
        await showAlert("ບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່");
      }
      renderStudentsAsync();
    });
  });
  app.querySelectorAll(".delete-user-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await showConfirm(`ລຶບບັນຊີຂອງ "${btn.dataset.name}" (${btn.dataset.phone}) ຖາວອນບໍ? ນັກຮຽນຄົນນີ້ຈະຕ້ອງລົງທະບຽນ ແລະ ຊຳລະເງິນໃໝ່ຖ້າຢາກຮຽນອີກ.`);
      if (!ok) return;
      btn.disabled = true;
      const deleted = await deleteUser(btn.dataset.phone);
      if (!deleted) await showAlert("ລຶບບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່");
      renderStudentsAsync();
    });
  });
  (function bindPaySettingsForm() {
    const qrInput = document.getElementById("qrUploadInput");
    const amountInput = document.getElementById("paySettingsAmount");
    const saveBtn = document.getElementById("savePaySettingsBtn");
    const msgEl = document.getElementById("paySettingsMsg");
    let newQrDataUrl = null;

    qrInput.addEventListener("change", async () => {
      const file = qrInput.files[0];
      if (!file) return;
      msgEl.textContent = "ກຳລັງໂຫລດຮູບ...";
      try {
        newQrDataUrl = await readImageAsLosslessDataUrl(file);
        msgEl.textContent = "ໂຫລດຮູບແລ້ວ, ກົດ 'ບັນທຶກການຕັ້ງຄ່າ' ເພື່ອບັນທຶກ";
      } catch (e) {
        msgEl.textContent = "ບໍ່ສາມາດອ່ານຮູບໄດ້, ລອງໃໝ່ອີກຄັ້ງ";
      }
    });

    saveBtn.addEventListener("click", async () => {
      const amount = Number(amountInput.value);
      if (!amount || amount < 0) {
        msgEl.textContent = "ກະລຸນາໃສ່ຈຳນວນເງິນທີ່ຖືກຕ້ອງ";
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "ກຳລັງບັນທຶກ...";
      const settings = { amount };
      if (newQrDataUrl) settings.qrImageDataUrl = newQrDataUrl;
      else if (paySettings.qrImageDataUrl) settings.qrImageDataUrl = paySettings.qrImageDataUrl;
      const ok = await savePaymentSettings(settings);
      if (!ok) {
        msgEl.textContent = "ບັນທຶກບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່";
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 ບັນທຶກການຕັ້ງຄ່າ";
        return;
      }
      renderStudentsAsync();
    });
  })();
  document.getElementById("toggleExamBtn").addEventListener("click", async () => {
    const cfg = await loadExamConfig();
    cfg.enabled = !cfg.enabled;
    if (cfg.enabled && !cfg.questions.length) {
      cfg.questions = generateExamQuestions(30);
    }
    delete cfg._offline;
    await saveExamConfig(cfg);
    renderStudentsAsync();
  });
  document.getElementById("regenExamBtn").addEventListener("click", async () => {
    if (!(await showConfirm("ສຸ່ມຄຳຖາມສອບເສັງໃໝ່ທັງ 30 ຂໍ້ບໍ? ຄຳຖາມເກົ່າ (ທີ່ອາດແກ້ໄຂໄວ້) ຈະຫາຍໄປ."))) return;
    const cfg = await loadExamConfig();
    cfg.questions = generateExamQuestions(30);
    delete cfg._offline;
    await saveExamConfig(cfg);
    renderStudentsAsync();
  });
  document.getElementById("editExamBtn").addEventListener("click", () => navigate("#/examedit"));
  document.getElementById("exportDataBtn").addEventListener("click", exportDataJs);
  document.getElementById("exportBackupBtn").addEventListener("click", exportOverridesBackup);
  document.getElementById("importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importOverridesBackup(e.target.files[0]);
  });
  document.getElementById("changePinBtn").addEventListener("click", async () => {
    const curInput = document.getElementById("curPinInput");
    const newInput = document.getElementById("newPinInput");
    const newInput2 = document.getElementById("newPinInput2");
    const msgEl = document.getElementById("changePinMsg");
    if (curInput.value !== currentAdminPin) {
      msgEl.textContent = "ລະຫັດ PIN ປັດຈຸບັນບໍ່ຖືກຕ້ອງ";
      return;
    }
    if (!newInput.value || newInput.value.length < 4) {
      msgEl.textContent = "ລະຫັດ PIN ໃໝ່ຕ້ອງມີຢ່າງໜ້ອຍ 4 ໂຕ";
      return;
    }
    if (newInput.value !== newInput2.value) {
      msgEl.textContent = "ລະຫັດ PIN ໃໝ່ທັງສອງຊ່ອງບໍ່ຄືກັນ";
      return;
    }
    const ok = await saveAdminPin(newInput.value);
    if (!ok) {
      msgEl.textContent = "ບັນທຶກບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່";
      return;
    }
    await showAlert("ປ່ຽນລະຫັດ PIN ສຳເລັດແລ້ວ!");
    renderStudentsAsync();
  });
  document.getElementById("lockAdminBtn").addEventListener("click", () => {
    lockAdmin();
    navigate("#/home");
  });
}

// ---------- Export / import (admin data portability) ----------
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function exportDataJs() {
  const merged = getTopics().map((t) => ({
    id: t.id,
    icon: t.icon,
    title_lo: t.title_lo,
    title_ko: t.title_ko,
    subLessons: t.subLessons.map((s) => ({
      id: s.id, icon: s.icon, title_lo: s.title_lo, title_ko: s.title_ko, sections: s.sections,
    })),
  }));
  const js = "// Transcribed content from the Korean-Lao textbook for seasonal workers.\nconst LESSONS = " + JSON.stringify(merged, null, 2) + ";\n";
  downloadTextFile("data.js", js);
}
function exportOverridesBackup() {
  downloadTextFile("kolo_content_overrides_backup.json", JSON.stringify(loadOverrides(), null, 2));
}
function importOverridesBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      saveOverrides(data);
      await showAlert("ນຳເຂົ້າສຳເລັດແລ້ວ!");
      render();
    } catch (e) {
      await showAlert("ໄຟລ໌ບໍ່ຖືກຕ້ອງ, ກະລຸນາລອງໃໝ່.");
    }
  };
  reader.readAsText(file);
}

// ---------- Home view (5 topics) ----------
function renderHome() {
  backBtn.classList.add("hidden");
  topTitle.textContent = "ຮຽນພາສາເກົາຫຼີ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderHomeAsync();
}
async function renderHomeAsync() {
  await refreshUnlockedStatus();
  const topics = getTopics();
  const prog = loadProgress();
  const cards = topics.map((topic, i) => {
    const locked = isTopicLocked(topic.id);
    const subs = topic.subLessons;
    const passedCount = subs.filter((s) => prog[s.id] && prog[s.id].passed).length;
    const anyStarted = subs.some((s) => prog[s.id] && (prog[s.id].viewed || prog[s.id].bestTotal));
    let badge = '<span class="badge not-started">ຍັງບໍ່ໄດ້ຮຽນ</span>';
    if (locked) {
      badge = '<span class="badge locked">🔒 ຕ້ອງຊຳລະເງິນ</span>';
    } else if (passedCount === subs.length) {
      badge = `<span class="badge passed">ຜ່ານໝົດ ${passedCount}/${subs.length}</span>`;
    } else if (anyStarted) {
      badge = `<span class="badge in-progress">${passedCount}/${subs.length} ບົດຜ່ານ</span>`;
    }
    const itemCount = subs.reduce((n, s) => n + allItems(s).length, 0);
    return `
      <div class="lesson-card ${locked ? "locked-card" : ""}" data-id="${topic.id}" data-locked="${locked ? "1" : "0"}">
        <div class="lesson-icon">${locked ? "🔒" : (topic.icon || "📘")}</div>
        <div class="lesson-info">
          <div class="title-lo">${i + 1}. ${topic.title_lo}</div>
          <div class="title-ko ko">${topic.title_ko || ""}</div>
          <div class="meta">${subs.length} ໝວດຍ່ອຍ · ${itemCount} ຄຳ/ປະໂຫຍກ</div>
        </div>
        ${badge}
      </div>`;
  }).join("");

  app.innerHTML = `
    <div class="intro">
      <h2>ສະບາຍດີ 👋</h2>
      <p>ຮຽນຄຳສັບ ແລະ ປະໂຫຍກພາສາເກົາຫຼີທີ່ຈຳເປັນສຳລັບແຮງງານລະດູການ. ຫົວຂໍ້ທຳອິດຮຽນໄດ້ຟຣີ, ຫົວຂໍ້ອື່ນໆຕ້ອງຊຳລະເງິນກ່ອນ.</p>
    </div>
    <div class="lesson-list">${cards}</div>
    <button class="link-btn" id="examLinkBtn">📝 ລົງຊື່ເຂົ້າສອບເສັງ (ສະເພາະສອບເສັງທາງການ)</button>
    <button class="link-btn" id="rosterLinkBtn">📋 ລາຍຊື່ນັກຮຽນ ແລະ ຄະແນນ (ສຳລັບຄູ/ແອັດມິນ)</button>
  `;

  app.querySelectorAll(".lesson-card").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.locked === "1") navigate("#/paywall");
      else navigate("#/topic/" + el.dataset.id);
    });
  });
  document.getElementById("examLinkBtn").addEventListener("click", () => navigate("#/examname"));
  document.getElementById("rosterLinkBtn").addEventListener("click", () => navigate("#/students"));
}

// ---------- Search (logged-in only; locked accounts only search topic 1) ----------
function renderSearch() {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ຄົ້ນຫາຄຳສັບ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderSearchAsync();
}
async function renderSearchAsync() {
  await refreshUnlockedStatus();
  const unlocked = getCachedUnlocked();
  const searchIndex = getAllSubLessons()
    .filter((lesson) => unlocked || !isTopicLocked(lesson.topicId))
    .flatMap((lesson) =>
      allItems(lesson)
        .filter((it) => it.korean)
        .map((it) => Object.assign({}, it, { _lessonId: lesson.id, _lessonTitle: lesson.title_lo }))
    );

  app.innerHTML = `
    <div class="intro">
      <h2>🔍 ຄົ້ນຫາຄຳສັບ</h2>
      <p>ພິມຄຳສັບພາສາລາວ (ຄວາມໝາຍ ຫຼື ຄຳອ່ານ) ຫຼື ພາສາເກົາຫຼີ ເພື່ອຄົ້ນຫາ. ມີປຸ່ມ 🔊 ລາວ ໃຫ້ນາຍຈ້າງກົດຟັງສຽງຄວາມໝາຍເປັນພາສາລາວໄດ້ເລີຍ.${!unlocked ? " (ຄົ້ນຫາໄດ້ສະເພາະຫົວຂໍ້ທຳອິດ ຈົນກວ່າຈະຊຳລະເງິນ)" : ""}</p>
    </div>
    <input type="text" id="searchInput" class="search-input" placeholder="ພິມຄຳຄົ້ນຫາທີ່ນີ້..." autocomplete="off" />
    <div id="searchResults"></div>
  `;

  const input = document.getElementById("searchInput");
  const resultsEl = document.getElementById("searchResults");

  function renderResults(rawQuery) {
    const q = rawQuery.trim().toLowerCase();
    if (!q) {
      resultsEl.innerHTML = `<div class="search-hint">ພິມຄຳສັບຢ່າງໜ້ອຍ 1 ໂຕອັກສອນ ເພື່ອຄົ້ນຫາ...</div>`;
      return;
    }
    const matches = searchIndex
      .filter((it) =>
        (it.korean && it.korean.toLowerCase().includes(q)) ||
        (it.lao_phonetic && it.lao_phonetic.toLowerCase().includes(q)) ||
        (it.lao_meaning && it.lao_meaning.toLowerCase().includes(q))
      )
      .slice(0, 50);
    if (!matches.length) {
      resultsEl.innerHTML = `<div class="search-hint">ບໍ່ພົບຄຳສັບທີ່ຄົ້ນຫາ ລອງພິມຄຳອື່ນ</div>`;
      return;
    }
    resultsEl.innerHTML = matches.map((it) => vocabCardHtml(it, { showLesson: true })).join("");
    bindVocabCardEvents(resultsEl);
  }

  input.addEventListener("input", () => renderResults(input.value));
  input.focus();
  renderResults("");
}

// ---------- Paywall: pay via QR, upload proof, wait for admin approval ----------
function renderPaywall() {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ຊຳລະເງິນເພື່ອປົດລ໋ອກ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderPaywallAsync();
}
async function renderPaywallAsync() {
  const phone = getCurrentStudent();
  if (!phone) return navigate("#/name"); // defensive: never submit a proof with no student identity attached
  await refreshUnlockedStatus();
  if (getCachedUnlocked()) return navigate("#/home");

  const proof = await getMyLatestProof(phone);
  const settings = await loadPaymentSettings();
  const amountText = settings.amount.toLocaleString("en-US");

  let statusHtml = "";
  let formHtml = "";
  if (proof && proof.status === "pending") {
    statusHtml = `
      <div class="paywall-status pending">⏳ ຫຼັກຖານການໂອນຂອງທ່ານກຳລັງລໍຖ້າການກວດສອບຈາກແອັດມິນ. ກະລຸນາລໍຖ້າ ຫຼືກັບມາເບິ່ງພາຍຫຼັງ.</div>
      <img class="proof-preview" src="${proof.imageDataUrl}" alt="ຫຼັກຖານທີ່ສົ່ງແລ້ວ" />
    `;
  } else {
    if (proof && proof.status === "rejected") {
      statusHtml = `<div class="paywall-status rejected">❌ ຫຼັກຖານທີ່ສົ່ງມາກ່ອນໜ້ານີ້ບໍ່ຖືກຕ້ອງ, ກະລຸນາອັບໂຫລດໃໝ່.</div>`;
    }
    formHtml = `
      <label class="field-label" for="proofInput">ອັບໂຫລດຫຼັກຖານການໂອນເງິນ (ຮູບພາບ)</label>
      <input type="file" id="proofInput" accept="image/*" class="name-input" />
      <img id="proofPreview" class="proof-preview hidden" />
      <button class="btn-primary" id="proofSubmitBtn" disabled>ສົ່ງຫຼັກຖານ →</button>
      <div id="proofError" class="admin-pin-error"></div>
    `;
  }

  app.innerHTML = `
    <div class="intro">
      <h2>🔒 ຫົວຂໍ້ນີ້ຕ້ອງຊຳລະເງິນ</h2>
      <p>ໂອນເງິນຈຳນວນ <strong>${amountText} ກີບ</strong> ຜ່ານ QR ຂ້າງລຸ່ມ ແລ້ວອັບໂຫລດຫຼັກຖານການໂອນ. ຫຼັງແອັດມິນກວດສອບ ແລະ ອະນຸມັດແລ້ວ, ທ່ານຈະຮຽນໄດ້ທຸກຫົວຂໍ້ທັນທີ.</p>
    </div>
    <div class="qr-box">
      ${settings.qrImageDataUrl
        ? `<img src="${settings.qrImageDataUrl}" alt="QR ໂອນເງິນ" class="qr-image" />`
        : `<div class="qr-placeholder" style="display:flex">📷<br>ຮູບ QR ໂອນເງິນ<br>(ແອັດມິນຍັງບໍ່ໄດ້ຕັ້ງຄ່າ)</div>`}
      <div class="qr-amount">${amountText} ກີບ</div>
    </div>
    ${statusHtml}
    ${formHtml}
  `;

  if (formHtml) {
    const fileInput = document.getElementById("proofInput");
    const preview = document.getElementById("proofPreview");
    const submitBtn = document.getElementById("proofSubmitBtn");
    const errorEl = document.getElementById("proofError");
    let compressedDataUrl = null;

    fileInput.addEventListener("change", async () => {
      errorEl.textContent = "";
      const file = fileInput.files[0];
      if (!file) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "ກຳລັງໂຫລດຮູບ...";
      try {
        compressedDataUrl = await readImageAsCompressedDataUrl(file);
        preview.src = compressedDataUrl;
        preview.classList.remove("hidden");
        submitBtn.disabled = false;
        submitBtn.textContent = "ສົ່ງຫຼັກຖານ →";
      } catch (e) {
        errorEl.textContent = "ບໍ່ສາມາດອ່ານຮູບໄດ້, ລອງໃໝ່ອີກຄັ້ງ";
        submitBtn.textContent = "ສົ່ງຫຼັກຖານ →";
      }
    });

    submitBtn.addEventListener("click", async () => {
      if (!compressedDataUrl) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "ກຳລັງສົ່ງ...";
      const ok = await submitPaymentProof(phone, getCurrentStudentName(), compressedDataUrl, settings.amount);
      if (!ok) {
        errorEl.textContent = "ສົ່ງບໍ່ສຳເລັດ, ກວດສອບອິນເຕີເນັດແລ້ວລອງໃໝ່";
        submitBtn.disabled = false;
        submitBtn.textContent = "ສົ່ງຫຼັກຖານ →";
        return;
      }
      renderPaywallAsync();
    });
  }
}

// ---------- Topic view (sub-lesson list within a topic) ----------
function renderTopic(topicId) {
  const topic = findTopic(topicId);
  if (!topic) return navigate("#/home");
  if (isTopicLocked(topicId)) return navigate("#/paywall");
  backBtn.classList.remove("hidden");
  topTitle.textContent = topic.title_lo;

  const cards = topic.subLessons.map((sub, i) => {
    const prog = getLessonProgress(sub.id);
    let badge = '<span class="badge not-started">ຍັງບໍ່ໄດ້ຮຽນ</span>';
    if (prog.passed) {
      badge = `<span class="badge passed">ຜ່ານ ${prog.bestScore}/${prog.bestTotal}</span>`;
    } else if (prog.bestTotal > 0) {
      badge = `<span class="badge failed">ຄະແນນ ${prog.bestScore}/${prog.bestTotal}</span>`;
    } else if (prog.viewed) {
      badge = '<span class="badge in-progress">ກຳລັງຮຽນ</span>';
    }
    const itemCount = allItems(sub).length;
    return `
      <div class="lesson-card" data-id="${sub.id}">
        <div class="lesson-icon">${sub.icon || "📘"}</div>
        <div class="lesson-info">
          <div class="title-lo">${i + 1}. ${sub.title_lo}</div>
          <div class="title-ko ko">${sub.title_ko || ""}</div>
          <div class="meta">${itemCount} ຄຳ/ປະໂຫຍກ</div>
        </div>
        ${badge}
      </div>`;
  }).join("");

  app.innerHTML = `
    <div class="intro">
      <h2>${topic.icon} ${topic.title_lo}</h2>
      <p>ເລືອກໝວດຍ່ອຍທີ່ຢາກຮຽນ. ຮຽນຈົບແຕ່ລະໝວດແລ້ວລອງເຮັດແບບທົດສອບ.</p>
    </div>
    <div class="lesson-list">${cards}</div>
  `;

  app.querySelectorAll(".lesson-card").forEach((el) => {
    el.addEventListener("click", () => navigate("#/lesson/" + el.dataset.id));
  });
}

// ---------- Shared vocab card (used by lesson view and search) ----------
function vocabCardHtml(item, opts = {}) {
  if (!item.korean && !item.lao_phonetic) {
    // Info-only item (e.g. emergency contact directory row) — no pronunciation to teach.
    return `
      <div class="vocab-card">
        <div class="vocab-meaning">${item.lao_meaning}</div>
      </div>`;
  }
  const icon = item.icon ? `<span class="vocab-icon">${item.icon}</span>` : "";
  const lessonTag = opts.showLesson && item._lessonTitle
    ? `<button class="vocab-lesson-tag" data-lesson-id="${item._lessonId}">${item._lessonTitle}</button>`
    : "";
  return `
      <div class="vocab-card">
        ${lessonTag}
        <div class="vocab-row">
          <div class="vocab-main">
            <div class="vocab-phonetic">${icon}${item.lao_phonetic || ""}</div>
            ${item.korean ? `<div class="vocab-korean ko">${item.korean}</div>` : ""}
          </div>
          <div class="vocab-speak-btns">
            ${item.korean ? `<button class="speak-btn" data-lang="ko" data-text="${escapeAttr(item.korean)}" aria-label="ຟັງສຽງພາສາເກົາຫຼີ">🔊 KO</button>` : ""}
            ${item.lao_meaning ? `<button class="speak-btn speak-btn-lo" data-lang="lo" data-text="${escapeAttr(item.lao_meaning)}" aria-label="ຟັງສຽງພາສາລາວ (ສຳລັບນາຍຈ້າງ)">🔊 ລາວ</button>` : ""}
          </div>
        </div>
        <div class="vocab-meaning">
          <span class="label">ຄວາມໝາຍ:</span>${item.lao_meaning}
        </div>
        ${item.note ? `<div class="vocab-note">${item.note}</div>` : ""}
        ${item.boss_korean_phonetic ? `<div class="vocab-boss">ນາຍຈ້າງເວົ້າວ່າ: ${item.boss_korean_phonetic}</div>` : ""}
      </div>`;
}
function bindVocabCardEvents(container) {
  container.querySelectorAll(".speak-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.lang === "lo") speakLao(btn.dataset.text);
      else speak(btn.dataset.text);
    });
  });
  container.querySelectorAll(".vocab-lesson-tag").forEach((btn) => {
    btn.addEventListener("click", () => navigate("#/lesson/" + btn.dataset.lessonId));
  });
}

// ---------- Lesson view ----------
function renderLesson(subId) {
  const lesson = findLesson(subId);
  if (!lesson) return navigate("#/home");
  if (isTopicLocked(lesson.topicId)) return navigate("#/paywall");
  backBtn.classList.remove("hidden");
  topTitle.textContent = lesson.title_lo;
  setLessonProgress(subId, { viewed: true });

  const navChips = lesson.sections
    .map((s, i) => (s.title_lo ? { title: s.title_lo, id: `sec-${i}` } : null))
    .filter(Boolean);

  const sectionsHtml = lesson.sections.map((section, i) => {
    const itemsHtml = section.items.map((item) => vocabCardHtml(item)).join("");

    const heading = section.title_lo
      ? `<div class="section-title" id="sec-${i}">${section.title_lo}${section.title_ko ? `<span class="ko">${section.title_ko}</span>` : ""}</div>`
      : "";
    return heading + itemsHtml;
  }).join("");

  const navHtml = navChips.length > 1
    ? `<div class="section-nav">${navChips.map((c) => `<button class="section-nav-chip" data-target="${c.id}">${c.title}</button>`).join("")}</div>`
    : "";

  app.innerHTML = `
    ${navHtml}
    ${sectionsHtml}
    <div class="lesson-footer">
      <button class="btn-primary" id="startQuizBtn">📝 ເລີ່ມເຮັດແບບທົດສອບ</button>
      <button class="btn-secondary" id="backTopicBtn">← ກັບໄປໝວດ${lesson.topicTitle_lo ? " " + lesson.topicTitle_lo : ""}</button>
    </div>
  `;

  bindVocabCardEvents(app);
  app.querySelectorAll(".section-nav-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const el = document.getElementById(chip.dataset.target);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.getElementById("startQuizBtn").addEventListener("click", () => navigate("#/quiz/" + subId));
  document.getElementById("backTopicBtn").addEventListener("click", () => navigate("#/topic/" + lesson.topicId));
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// ---------- Quiz view ----------
let quizState = null;

function buildQuiz(lesson) {
  const items = allItems(lesson);
  const questionable = items.filter((it) => it.korean);
  const otherItems = getAllSubLessons().filter((l) => l.id !== lesson.id).flatMap(allItems);
  const pool = shuffle(questionable).slice(0, Math.min(10, questionable.length));

  const questions = pool.map((correctItem) => {
    const distractSource = shuffle(
      items.filter((it) => it.lao_meaning !== correctItem.lao_meaning)
    );
    let distractors = distractSource.slice(0, 3);
    if (distractors.length < 3) {
      const extra = shuffle(otherItems.filter((it) => it.lao_meaning !== correctItem.lao_meaning));
      distractors = distractors.concat(extra.slice(0, 3 - distractors.length));
    }
    const choices = shuffle([correctItem.lao_meaning, ...distractors.map((d) => d.lao_meaning)]);
    return {
      korean: correctItem.korean,
      lao_phonetic: correctItem.lao_phonetic,
      answer: correctItem.lao_meaning,
      choices,
    };
  });

  return questions;
}

function renderQuiz(subId) {
  const lesson = findLesson(subId);
  if (!lesson) return navigate("#/home");
  if (isTopicLocked(lesson.topicId)) return navigate("#/paywall");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ແບບທົດສອບ";

  if (!quizState || quizState.lessonId !== subId) {
    quizState = {
      lessonId: subId,
      questions: buildQuiz(lesson),
      index: 0,
      score: 0,
      answered: false,
    };
  }
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const { questions, index } = quizState;
  const total = questions.length;
  const q = questions[index];
  const pct = Math.round((index / total) * 100);

  app.innerHTML = `
    <div class="quiz-q-count">ຄຳຖາມ ${index + 1} / ${total}</div>
    <div class="quiz-progress"><div class="quiz-progress-bar" style="width:${pct}%"></div></div>
    <div class="quiz-question">
      <div class="prompt-label">ຄຳນີ້ຄວາມໝາຍວ່າແນວໃດ?</div>
      <div class="prompt-phonetic">${q.lao_phonetic}</div>
      <div class="prompt-korean ko">${q.korean}</div>
      <button class="quiz-listen" id="quizListenBtn">🔊 ຟັງສຽງ</button>
    </div>
    <div class="quiz-choices" id="quizChoices">
      ${q.choices.map((c) => `<button class="choice-btn" data-choice="${escapeAttr(c)}">${c}</button>`).join("")}
    </div>
    <div class="quiz-next" id="quizNextWrap"></div>
  `;

  document.getElementById("quizListenBtn").addEventListener("click", () => speak(q.korean));

  app.querySelectorAll(".choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => onChoiceSelected(btn, q));
  });
}

function onChoiceSelected(btn, q) {
  if (quizState.answered) return;
  quizState.answered = true;
  const chosen = btn.dataset.choice;
  const correct = chosen === q.answer;
  if (correct) quizState.score++;

  app.querySelectorAll(".choice-btn").forEach((b) => {
    b.disabled = true;
    if (b.dataset.choice === q.answer) b.classList.add("correct");
    else if (b === btn) b.classList.add("wrong");
  });

  const isLast = quizState.index === quizState.questions.length - 1;
  const nextWrap = document.getElementById("quizNextWrap");
  nextWrap.innerHTML = `<button class="btn-primary" id="quizNextBtn">${isLast ? "ເບິ່ງຄະແນນ" : "ຄຳຖາມຕໍ່ໄປ →"}</button>`;
  document.getElementById("quizNextBtn").addEventListener("click", () => {
    if (isLast) {
      finishQuiz();
    } else {
      quizState.index++;
      quizState.answered = false;
      renderQuizQuestion();
    }
  });
}

function finishQuiz() {
  const { lessonId, score, questions } = quizState;
  const total = questions.length;
  const passed = score / total >= 0.7;
  const prog = getLessonProgress(lessonId);
  if (score > prog.bestScore || total !== prog.bestTotal) {
    setLessonProgress(lessonId, {
      bestScore: Math.max(score, prog.passed ? prog.bestScore : score),
      bestTotal: total,
      passed: passed || prog.passed,
    });
  }
  navigate(`#/result/${lessonId}/${score}/${total}`);
  quizState = null;
}

// ---------- Result view ----------
function renderResult(subId, score, total) {
  const lesson = findLesson(subId);
  if (!lesson) return navigate("#/home");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ຜົນຄະແນນ";

  const pct = total ? Math.round((score / total) * 100) : 0;
  const passed = pct >= 70;

  app.innerHTML = `
    <div class="result-box">
      <div class="result-emoji">${passed ? "🎉" : "💪"}</div>
      <div class="result-score">${score} / ${total}</div>
      <div class="result-msg ${passed ? "pass" : "fail"}">
        ${passed ? "ຍິນດີນຳ! ເຈົ້າຜ່ານແບບທົດສອບແລ້ວ" : "ພະຍາຍາມອີກຄັ້ງ ເຈົ້າຕ້ອງໄດ້ 70% ຂຶ້ນໄປຈຶ່ງຈະຜ່ານ"}
      </div>
      <button class="btn-primary" id="retryBtn">🔁 ເຮັດແບບທົດສອບໃໝ່</button>
      <button class="btn-secondary" id="reviewBtn">📖 ທົບທວນບົດຮຽນ</button>
      <button class="btn-secondary" id="topicBtn">📚 ໝວດ${lesson.topicTitle_lo ? " " + lesson.topicTitle_lo : ""}</button>
      <button class="btn-secondary" id="homeBtn">🏠 ໜ້າຫຼັກ</button>
    </div>
  `;

  document.getElementById("retryBtn").addEventListener("click", () => {
    quizState = null;
    navigate("#/quiz/" + subId);
  });
  document.getElementById("reviewBtn").addEventListener("click", () => navigate("#/lesson/" + subId));
  document.getElementById("topicBtn").addEventListener("click", () => navigate("#/topic/" + lesson.topicId));
  document.getElementById("homeBtn").addEventListener("click", () => navigate("#/home"));
}

// ---------- Admin: edit lesson content ----------
let editDraft = null;

function renderEdit(subId) {
  const lesson = getAllSubLessons().find((l) => l.id === subId);
  if (!lesson) return navigate("#/students");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ແກ້ໄຂ: " + lesson.title_lo;

  editDraft = {
    lessonId: subId,
    icon: lesson.icon || "",
    title_lo: lesson.title_lo || "",
    title_ko: lesson.title_ko || "",
    items: flattenLesson(lesson),
  };

  renderEditView();
}

function editRowHtml(it, i) {
  return `
    <div class="edit-row" data-idx="${i}">
      <div class="edit-row-head">
        <span class="edit-row-num">#${i + 1}</span>
        <button class="icon-btn-sm move-up" data-idx="${i}" title="ຍ້າຍຂຶ້ນ">↑</button>
        <button class="icon-btn-sm move-down" data-idx="${i}" title="ຍ້າຍລົງ">↓</button>
        <button class="icon-btn-sm delete-row" data-idx="${i}" title="ລຶບ">🗑️</button>
      </div>
      <div class="edit-section-fields">
        <input class="edit-input section-lo" placeholder="ຫົວຂໍ້ພາກໃໝ່ (ຖ້າມີ, ພາສາລາວ)" value="${escapeAttr(it.section_lo || "")}" />
        <input class="edit-input section-ko" placeholder="ຫົວຂໍ້ພາກ (ພາສາເກົາຫຼີ, ບໍ່ບັງຄັບ)" value="${escapeAttr(it.section_ko || "")}" />
      </div>
      <div class="edit-grid">
        <div>
          <label>ໄອຄອນ (ບໍ່ບັງຄັບ)</label>
          <input class="edit-input f-icon" value="${escapeAttr(it.icon || "")}" />
        </div>
        <div>
          <label>ພາສາເກົາຫຼີ</label>
          <input class="edit-input f-korean" value="${escapeAttr(it.korean || "")}" />
        </div>
        <div>
          <label>ຄຳອ່ານພາສາລາວ</label>
          <input class="edit-input f-phonetic" value="${escapeAttr(it.lao_phonetic || "")}" />
        </div>
        <div>
          <label>ຄວາມໝາຍພາສາລາວ</label>
          <input class="edit-input f-meaning" value="${escapeAttr(it.lao_meaning || "")}" />
        </div>
        <div>
          <label>ນາຍຈ້າງເວົ້າວ່າ (ບໍ່ບັງຄັບ)</label>
          <input class="edit-input f-boss" value="${escapeAttr(it.boss_korean_phonetic || "")}" />
        </div>
      </div>
    </div>`;
}

function renderEditView() {
  app.innerHTML = `
    <div class="intro edit-intro">
      <h2>✏️ ແກ້ໄຂບົດຮຽນ</h2>
      <p>ແກ້ໄຂ, ເພີ່ມ, ຫຼືລຶບຄຳສັບ/ປະໂຫຍກຂອງໝວດນີ້. ການປ່ຽນແປງຈະຖືກບັນທຶກໄວ້ໃນເຄື່ອງນີ້ທັນທີທີ່ກົດ "ບັນທຶກ".</p>
    </div>
    <div class="edit-field-row">
      <div class="edit-field">
        <label>ໄອຄອນ</label>
        <input id="editIcon" type="text" value="${escapeAttr(editDraft.icon)}" />
      </div>
      <div class="edit-field wide">
        <label>ຊື່ໝວດ (ພາສາລາວ)</label>
        <input id="editTitleLo" type="text" value="${escapeAttr(editDraft.title_lo)}" />
      </div>
      <div class="edit-field wide">
        <label>ຊື່ໝວດ (ພາສາເກົາຫຼີ)</label>
        <input id="editTitleKo" type="text" value="${escapeAttr(editDraft.title_ko)}" />
      </div>
    </div>
    <div id="editRows">${editDraft.items.map((it, i) => editRowHtml(it, i)).join("")}</div>
    <button class="btn-secondary" id="addRowBtn">➕ ເພີ່ມຄຳສັບ/ປະໂຫຍກໃໝ່</button>
    <div class="lesson-footer edit-footer">
      <button class="btn-primary" id="saveEditBtn">💾 ບັນທຶກການແກ້ໄຂ</button>
      <button class="btn-secondary" id="resetEditBtn">↩️ ຄືນຄ່າເດີມ</button>
      <button class="btn-secondary" id="cancelEditBtn">← ກັບຄືນ (ບໍ່ບັນທຶກ)</button>
    </div>
  `;

  document.getElementById("editIcon").addEventListener("input", (e) => { editDraft.icon = e.target.value; });
  document.getElementById("editTitleLo").addEventListener("input", (e) => { editDraft.title_lo = e.target.value; });
  document.getElementById("editTitleKo").addEventListener("input", (e) => { editDraft.title_ko = e.target.value; });

  bindEditRowInputs();

  document.getElementById("addRowBtn").addEventListener("click", () => {
    editDraft.items.push({ section_lo: null, section_ko: null, korean: "", lao_phonetic: "", lao_meaning: "", boss_korean_phonetic: "", icon: "" });
    renderEditView();
    const rows = document.querySelectorAll(".edit-row");
    if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.getElementById("saveEditBtn").addEventListener("click", saveEditDraft);
  document.getElementById("resetEditBtn").addEventListener("click", async () => {
    if (!(await showConfirm("ຄືນຄ່າໝວດນີ້ກັບຄືນຄ່າເດີມ ແລະ ຍົກເລີກການແກ້ໄຂທັງໝົດບໍ?"))) return;
    const overrides = loadOverrides();
    delete overrides[editDraft.lessonId];
    saveOverrides(overrides);
    editDraft = null;
    navigate("#/students");
  });
  document.getElementById("cancelEditBtn").addEventListener("click", () => {
    editDraft = null;
    navigate("#/students");
  });
}

function bindEditRowInputs() {
  document.querySelectorAll(".edit-row").forEach((rowEl) => {
    const idx = Number(rowEl.dataset.idx);
    rowEl.querySelector(".section-lo").addEventListener("input", (e) => { editDraft.items[idx].section_lo = e.target.value || null; });
    rowEl.querySelector(".section-ko").addEventListener("input", (e) => { editDraft.items[idx].section_ko = e.target.value || null; });
    rowEl.querySelector(".f-icon").addEventListener("input", (e) => { editDraft.items[idx].icon = e.target.value; });
    rowEl.querySelector(".f-korean").addEventListener("input", (e) => { editDraft.items[idx].korean = e.target.value; });
    rowEl.querySelector(".f-phonetic").addEventListener("input", (e) => { editDraft.items[idx].lao_phonetic = e.target.value; });
    rowEl.querySelector(".f-meaning").addEventListener("input", (e) => { editDraft.items[idx].lao_meaning = e.target.value; });
    rowEl.querySelector(".f-boss").addEventListener("input", (e) => { editDraft.items[idx].boss_korean_phonetic = e.target.value; });
    rowEl.querySelector(".delete-row").addEventListener("click", async () => {
      if (editDraft.items.length <= 1) {
        await showAlert("ຕ້ອງມີຢ່າງໜ້ອຍ 1 ລາຍການ");
        return;
      }
      editDraft.items.splice(idx, 1);
      renderEditView();
    });
    rowEl.querySelector(".move-up").addEventListener("click", () => {
      if (idx === 0) return;
      const tmp = editDraft.items[idx - 1];
      editDraft.items[idx - 1] = editDraft.items[idx];
      editDraft.items[idx] = tmp;
      renderEditView();
    });
    rowEl.querySelector(".move-down").addEventListener("click", () => {
      if (idx === editDraft.items.length - 1) return;
      const tmp = editDraft.items[idx + 1];
      editDraft.items[idx + 1] = editDraft.items[idx];
      editDraft.items[idx] = tmp;
      renderEditView();
    });
  });
}

async function saveEditDraft() {
  const cleaned = editDraft.items
    .filter((it) => it.korean || it.lao_phonetic || it.lao_meaning)
    .map((it) => {
      const out = {
        korean: it.korean || "",
        lao_phonetic: it.lao_phonetic || "",
        lao_meaning: it.lao_meaning || "",
      };
      if (it.section_lo) out.section_lo = it.section_lo;
      if (it.section_ko) out.section_ko = it.section_ko;
      if (it.boss_korean_phonetic) out.boss_korean_phonetic = it.boss_korean_phonetic;
      if (it.note) out.note = it.note;
      if (it.icon) out.icon = it.icon;
      return out;
    });

  const overrides = loadOverrides();
  overrides[editDraft.lessonId] = {
    icon: editDraft.icon,
    title_lo: editDraft.title_lo,
    title_ko: editDraft.title_ko,
    flatItems: cleaned,
  };
  saveOverrides(overrides);
  editDraft = null;
  await showAlert("ບັນທຶກສຳເລັດແລ້ວ!");
  navigate("#/students");
}

// ---------- Official exam: student sign-in ----------
function renderExamNameEntry() {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ລົງຊື່ເຂົ້າສອບເສັງ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  renderExamNameEntryAsync();
}

async function renderExamNameEntryAsync() {
  const cfg = await loadExamConfig();

  if (cfg._offline) {
    app.innerHTML = `
      <div class="intro edit-intro">
        <h2>📡 ເຊື່ອມຕໍ່ອິນເຕີເນັດບໍ່ໄດ້</h2>
        <p>ການສອບເສັງທາງການຕ້ອງໃຊ້ອິນເຕີເນັດ. ກະລຸນາກວດສອບການເຊື່ອມຕໍ່ແລ້ວລອງໃໝ່.</p>
      </div>
      <button class="btn-secondary" id="examBackHomeBtn">← ກັບໄປໜ້າຫຼັກ</button>
    `;
    document.getElementById("examBackHomeBtn").addEventListener("click", () => navigate("#/home"));
    return;
  }

  if (!cfg.enabled) {
    app.innerHTML = `
      <div class="intro edit-intro">
        <h2>🔒 ຍັງບໍ່ເປີດຮັບລົງທະບຽນ</h2>
        <p>ການສອບເສັງທາງການຍັງບໍ່ໄດ້ເປີດໃນຕອນນີ້. ກະລຸນາລໍຖ້າແອັດມິນເປີດການສອບເສັງ.</p>
      </div>
      <button class="btn-secondary" id="examBackHomeBtn">← ກັບໄປໜ້າຫຼັກ</button>
    `;
    document.getElementById("examBackHomeBtn").addEventListener("click", () => navigate("#/home"));
    return;
  }

  if (!cfg.questions.length) {
    app.innerHTML = `
      <div class="intro edit-intro">
        <h2>⚠️ ຍັງບໍ່ມີຄຳຖາມສອບເສັງ</h2>
        <p>ແອັດມິນຍັງບໍ່ໄດ້ສ້າງຄຳຖາມສອບເສັງ. ກະລຸນາແຈ້ງແອັດມິນ.</p>
      </div>
      <button class="btn-secondary" id="examBackHomeBtn">← ກັບໄປໜ້າຫຼັກ</button>
    `;
    document.getElementById("examBackHomeBtn").addEventListener("click", () => navigate("#/home"));
    return;
  }

  app.innerHTML = `
    <div class="intro">
      <h2>📝 ລົງຊື່ເຂົ້າສອບເສັງ</h2>
      <p>ບ່ອນນີ້ສະເພາະນັກຮຽນທີ່ຈະສອບເສັງທາງການ (${cfg.questions.length} ຂໍ້). ກະລຸນາຂຽນຊື່-ນາມສະກຸນຂອງທ່ານໃຫ້ຖືກຕ້ອງ.</p>
    </div>
    <label class="field-label" for="examNameInput">ຊື່ ແລະ ນາມສະກຸນ</label>
    <input id="examNameInput" class="name-input" type="text" placeholder="ຂຽນຊື່ຂອງທ່ານທີ່ນີ້..." autocomplete="off" />
    <button class="btn-primary" id="examNameStartBtn">ເລີ່ມສອບເສັງ →</button>
  `;

  const input = document.getElementById("examNameInput");
  const start = () => {
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    setCurrentExamTaker(input.value);
    examQuizState = null;
    navigate("#/examquiz");
  };
  document.getElementById("examNameStartBtn").addEventListener("click", start);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") start();
  });
  input.focus();
}

// ---------- Official exam: 30-question quiz ----------
let examQuizState = null;

async function buildExamQuiz() {
  const cfg = await loadExamConfig();
  const all = cfg.questions;
  const wholePool = getAllSubLessons().flatMap(allItems).filter((it) => it.korean);

  return shuffle(all).map((correctItem) => {
    const distractSource = shuffle(all.filter((it) => it.lao_meaning !== correctItem.lao_meaning));
    let distractors = distractSource.slice(0, 3);
    if (distractors.length < 3) {
      const extra = shuffle(wholePool.filter((it) => it.lao_meaning !== correctItem.lao_meaning));
      distractors = distractors.concat(extra.slice(0, 3 - distractors.length));
    }
    const choices = shuffle([correctItem.lao_meaning, ...distractors.map((d) => d.lao_meaning)]);
    return {
      korean: correctItem.korean,
      lao_phonetic: correctItem.lao_phonetic,
      answer: correctItem.lao_meaning,
      choices,
    };
  });
}

function renderExamQuiz() {
  if (!getCurrentExamTaker()) return navigate("#/examname");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ການສອບເສັງທາງການ";

  if (examQuizState) {
    renderExamQuizQuestion();
    return;
  }
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  buildExamQuiz().then((questions) => {
    examQuizState = { questions, index: 0, score: 0, answered: false };
    renderExamQuizQuestion();
  });
}

function renderExamQuizQuestion() {
  const { questions, index } = examQuizState;
  const total = questions.length;
  const q = questions[index];
  const pct = Math.round((index / total) * 100);

  app.innerHTML = `
    <div class="quiz-q-count">ຄຳຖາມ ${index + 1} / ${total}</div>
    <div class="quiz-progress"><div class="quiz-progress-bar" style="width:${pct}%"></div></div>
    <div class="quiz-question">
      <div class="prompt-label">ຄຳນີ້ຄວາມໝາຍວ່າແນວໃດ?</div>
      <div class="prompt-phonetic">${q.lao_phonetic}</div>
      <div class="prompt-korean ko">${q.korean}</div>
      <button class="quiz-listen" id="quizListenBtn">🔊 ຟັງສຽງ</button>
    </div>
    <div class="quiz-choices" id="quizChoices">
      ${q.choices.map((c) => `<button class="choice-btn" data-choice="${escapeAttr(c)}">${c}</button>`).join("")}
    </div>
    <div class="quiz-next" id="quizNextWrap"></div>
  `;

  document.getElementById("quizListenBtn").addEventListener("click", () => speak(q.korean));
  app.querySelectorAll(".choice-btn").forEach((btn) => {
    btn.addEventListener("click", () => onExamChoiceSelected(btn, q));
  });
}

function onExamChoiceSelected(btn, q) {
  if (examQuizState.answered) return;
  examQuizState.answered = true;
  const chosen = btn.dataset.choice;
  if (chosen === q.answer) examQuizState.score++;

  app.querySelectorAll(".choice-btn").forEach((b) => {
    b.disabled = true;
    if (b.dataset.choice === q.answer) b.classList.add("correct");
    else if (b === btn) b.classList.add("wrong");
  });

  const isLast = examQuizState.index === examQuizState.questions.length - 1;
  const nextWrap = document.getElementById("quizNextWrap");
  nextWrap.innerHTML = `<button class="btn-primary" id="quizNextBtn">${isLast ? "ເບິ່ງຄະແນນ" : "ຄຳຖາມຕໍ່ໄປ →"}</button>`;
  document.getElementById("quizNextBtn").addEventListener("click", () => {
    if (isLast) {
      finishExamQuiz();
    } else {
      examQuizState.index++;
      examQuizState.answered = false;
      renderExamQuizQuestion();
    }
  });
}

async function finishExamQuiz() {
  const { score, questions } = examQuizState;
  const total = questions.length;
  const name = getCurrentExamTaker();
  examQuizState = null;
  app.innerHTML = `<div class="empty-msg">ກຳລັງບັນທຶກຄະແນນ...</div>`;
  await addExamResult(name, score, total);
  navigate(`#/examresult/${score}/${total}`);
}

// ---------- Official exam: result ----------
function renderExamResult(score, total) {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ຜົນສອບເສັງ";
  const name = getCurrentExamTaker();
  const pct = total ? Math.round((score / total) * 100) : 0;
  const passed = pct >= 70;

  app.innerHTML = `
    <div class="result-box">
      <div class="result-emoji">${passed ? "🎉" : "💪"}</div>
      <div class="result-score">${score} / ${total}</div>
      <div class="result-msg ${passed ? "pass" : "fail"}">
        ${name ? name + " — " : ""}${passed ? "ຜ່ານການສອບເສັງ!" : "ຍັງບໍ່ຜ່ານ (ຕ້ອງໄດ້ 70% ຂຶ້ນໄປ)"}
      </div>
      <button class="btn-primary" id="nextTakerBtn">👤 ນັກຮຽນຄົນຕໍ່ໄປ</button>
      <button class="btn-secondary" id="examHomeBtn">🏠 ໜ້າຫຼັກ</button>
    </div>
  `;

  document.getElementById("nextTakerBtn").addEventListener("click", () => {
    clearCurrentExamTaker();
    navigate("#/examname");
  });
  document.getElementById("examHomeBtn").addEventListener("click", () => {
    clearCurrentExamTaker();
    navigate("#/home");
  });
}

// ---------- Admin: edit official exam questions ----------
let examEditDraft = null;

function renderExamEdit() {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ແກ້ໄຂຄຳຖາມສອບເສັງ";
  app.innerHTML = `<div class="empty-msg">ກຳລັງໂຫລດ...</div>`;
  loadExamConfig().then((cfg) => {
    examEditDraft = {
      questions: cfg.questions.map((q) => Object.assign({}, q)),
    };
    renderExamEditView();
  });
}

function examEditRowHtml(it, i) {
  return `
    <div class="edit-row" data-idx="${i}">
      <div class="edit-row-head">
        <span class="edit-row-num">#${i + 1}</span>
        <button class="icon-btn-sm shuffle-row" data-idx="${i}" title="ສຸ່ມຄຳຖາມໃໝ່ແທນຂໍ້ນີ້">🔄</button>
        <button class="icon-btn-sm delete-row" data-idx="${i}" title="ລຶບ">🗑️</button>
      </div>
      <div class="edit-grid">
        <div>
          <label>ພາສາເກົາຫຼີ</label>
          <input class="edit-input f-korean" value="${escapeAttr(it.korean || "")}" />
        </div>
        <div>
          <label>ຄຳອ່ານພາສາລາວ</label>
          <input class="edit-input f-phonetic" value="${escapeAttr(it.lao_phonetic || "")}" />
        </div>
        <div class="full-span">
          <label>ຄວາມໝາຍພາສາລາວ</label>
          <input class="edit-input f-meaning" value="${escapeAttr(it.lao_meaning || "")}" />
        </div>
      </div>
    </div>`;
}

function renderExamEditView() {
  app.innerHTML = `
    <div class="intro edit-intro">
      <h2>📝 ແກ້ໄຂຄຳຖາມສອບເສັງ</h2>
      <p>ແກ້ໄຂ, ສຸ່ມແທນ, ຫຼືລຶບ ຄຳຖາມສອບເສັງ. ປັດຈຸບັນມີ ${examEditDraft.questions.length} ຂໍ້.</p>
    </div>
    <div id="editRows">${examEditDraft.questions.map((it, i) => examEditRowHtml(it, i)).join("")}</div>
    <button class="btn-secondary" id="addExamRowBtn">➕ ເພີ່ມຄຳຖາມສຸ່ມ 1 ຂໍ້</button>
    <div class="lesson-footer edit-footer">
      <button class="btn-primary" id="saveExamEditBtn">💾 ບັນທຶກ</button>
      <button class="btn-secondary" id="cancelExamEditBtn">← ກັບຄືນ (ບໍ່ບັນທຶກ)</button>
    </div>
  `;

  bindExamEditRowInputs();

  document.getElementById("addExamRowBtn").addEventListener("click", async () => {
    const used = new Set(examEditDraft.questions.map((q) => q.korean));
    const pool = getAllSubLessons().flatMap(allItems).filter((it) => it.korean && it.lao_meaning && !used.has(it.korean));
    if (!pool.length) {
      await showAlert("ບໍ່ມີຄຳສັບເຫຼືອໃຫ້ສຸ່ມແລ້ວ");
      return;
    }
    const pick = shuffle(pool)[0];
    examEditDraft.questions.push({ korean: pick.korean, lao_phonetic: pick.lao_phonetic, lao_meaning: pick.lao_meaning });
    renderExamEditView();
  });

  document.getElementById("saveExamEditBtn").addEventListener("click", async () => {
    const cfg = await loadExamConfig();
    cfg.questions = examEditDraft.questions.filter((q) => q.korean || q.lao_phonetic || q.lao_meaning);
    delete cfg._offline;
    const ok = await saveExamConfig(cfg);
    examEditDraft = null;
    if (ok) await showAlert("ບັນທຶກສຳເລັດແລ້ວ!");
    navigate("#/students");
  });
  document.getElementById("cancelExamEditBtn").addEventListener("click", () => {
    examEditDraft = null;
    navigate("#/students");
  });
}

function bindExamEditRowInputs() {
  document.querySelectorAll(".edit-row").forEach((rowEl) => {
    const idx = Number(rowEl.dataset.idx);
    rowEl.querySelector(".f-korean").addEventListener("input", (e) => { examEditDraft.questions[idx].korean = e.target.value; });
    rowEl.querySelector(".f-phonetic").addEventListener("input", (e) => { examEditDraft.questions[idx].lao_phonetic = e.target.value; });
    rowEl.querySelector(".f-meaning").addEventListener("input", (e) => { examEditDraft.questions[idx].lao_meaning = e.target.value; });
    rowEl.querySelector(".delete-row").addEventListener("click", () => {
      examEditDraft.questions.splice(idx, 1);
      renderExamEditView();
    });
    rowEl.querySelector(".shuffle-row").addEventListener("click", async () => {
      const used = new Set(examEditDraft.questions.map((q) => q.korean));
      const pool = getAllSubLessons().flatMap(allItems).filter((it) => it.korean && it.lao_meaning && !used.has(it.korean));
      if (!pool.length) {
        await showAlert("ບໍ່ມີຄຳສັບເຫຼືອໃຫ້ສຸ່ມແລ້ວ");
        return;
      }
      const pick = shuffle(pool)[0];
      examEditDraft.questions[idx] = { korean: pick.korean, lao_phonetic: pick.lao_phonetic, lao_meaning: pick.lao_meaning };
      renderExamEditView();
    });
  });
}
