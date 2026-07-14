// ---------- Admin PIN gate ----------
// Change this PIN to whatever the admin wants. It only guards against students
// accidentally wandering into the roster/edit pages — not real security.
const ADMIN_PIN = "1234";
const ADMIN_UNLOCK_KEY = "kolo_admin_unlocked";

function isAdminUnlocked() {
  return sessionStorage.getItem(ADMIN_UNLOCK_KEY) === "1";
}
function lockAdmin() {
  sessionStorage.removeItem(ADMIN_UNLOCK_KEY);
}

// ---------- Student registry & progress storage ----------
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
function studentNames() {
  return Object.keys(loadStudents()).sort((a, b) => a.localeCompare(b, "lo"));
}
function getCurrentStudent() {
  return localStorage.getItem(CURRENT_KEY) || "";
}
function setCurrentStudent(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const students = loadStudents();
  if (!students[trimmed]) students[trimmed] = {};
  saveStudents(students);
  localStorage.setItem(CURRENT_KEY, trimmed);
}
function clearCurrentStudent() {
  localStorage.removeItem(CURRENT_KEY);
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
function getLessonProgress(lessonId) {
  const p = loadProgress();
  return p[lessonId] || { viewed: false, bestScore: 0, bestTotal: 0, passed: false };
}
function setLessonProgress(lessonId, patch) {
  const p = loadProgress();
  p[lessonId] = Object.assign(getLessonProgress(lessonId), patch);
  saveProgress(p);
}

// ---------- Lesson content overrides (admin edits) ----------
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

function getLessons() {
  const overrides = loadOverrides();
  return LESSONS.map((lesson) => {
    const ov = overrides[lesson.id];
    if (!ov) return lesson;
    return {
      id: lesson.id,
      icon: ov.icon != null && ov.icon !== "" ? ov.icon : lesson.icon,
      title_lo: ov.title_lo != null && ov.title_lo !== "" ? ov.title_lo : lesson.title_lo,
      title_ko: ov.title_ko != null && ov.title_ko !== "" ? ov.title_ko : lesson.title_ko,
      sections: groupIntoSections(ov.flatItems),
    };
  });
}

// ---------- Helpers ----------
function findLesson(id) {
  return getLessons().find((l) => l.id === id);
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

// ---------- Text to speech ----------
let koreanVoice = null;
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
if (window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
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

// ---------- Router ----------
const app = document.getElementById("app");
const topTitle = document.getElementById("topTitle");
const backBtn = document.getElementById("backBtn");
const studentBtn = document.getElementById("studentBtn");

function navigate(hash) {
  window.location.hash = hash;
}
backBtn.addEventListener("click", () => {
  const parts = currentRoute();
  if (parts.view === "lesson" || parts.view === "quiz" || parts.view === "students") navigate("#/home");
  else if (parts.view === "edit") navigate("#/students");
  else if (parts.view === "result") navigate("#/lesson/" + parts.id);
  else navigate("#/home");
});
studentBtn.addEventListener("click", () => navigate("#/name"));

function currentRoute() {
  const hash = window.location.hash.replace(/^#\//, "");
  const parts = hash.split("/");
  if (parts[0] === "name") return { view: "name" };
  if (parts[0] === "students") return { view: "students" };
  if (parts[0] === "edit") return { view: "edit", id: parts[1] };
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

  const needsStudent = ["home", "lesson", "quiz", "result"].includes(route.view);
  if (needsStudent && !getCurrentStudent()) return navigate("#/name");

  const needsAdmin = route.view === "students" || route.view === "edit";
  if (needsAdmin && !isAdminUnlocked()) return renderAdminGate(window.location.hash || "#/students");

  updateStudentBadge(route.view);

  if (route.view === "name") return renderNameEntry();
  if (route.view === "students") return renderStudents();
  if (route.view === "edit") return renderEdit(route.id);
  if (route.view === "home") return renderHome();
  if (route.view === "lesson") return renderLesson(route.id);
  if (route.view === "quiz") return renderQuiz(route.id);
  if (route.view === "result") return renderResult(route.id, Number(route.score), Number(route.total));
  renderHome();
}

function updateStudentBadge(view) {
  const name = getCurrentStudent();
  if (view === "name" || !name) {
    studentBtn.classList.add("hidden");
  } else {
    studentBtn.classList.remove("hidden");
    studentBtn.textContent = "👤 " + name;
  }
}

// ---------- Name entry view ----------
function renderNameEntry() {
  backBtn.classList.toggle("hidden", !getCurrentStudent());
  topTitle.textContent = "ຊື່ນັກຮຽນ";

  const names = studentNames();
  const chips = names.length
    ? `<div class="name-chips">${names
        .map((n) => `<button class="name-chip" data-name="${escapeAttr(n)}">${n}</button>`)
        .join("")}</div>`
    : "";

  app.innerHTML = `
    <div class="intro">
      <h2>ຍິນດີຕ້ອນຮັບ 🙋</h2>
      <p>ກະລຸນາຂຽນຊື່ຂອງທ່ານ ເພື່ອບັນທຶກຄວາມຄືບໜ້າ ແລະ ຄະແນນສອບເສັງຂອງທ່ານ.</p>
    </div>
    <label class="field-label" for="nameInput">ຊື່ ແລະ ນາມສະກຸນ</label>
    <input id="nameInput" class="name-input" type="text" placeholder="ຂຽນຊື່ຂອງທ່ານທີ່ນີ້..." autocomplete="off" />
    <button class="btn-primary" id="nameStartBtn">ເລີ່ມຮຽນ →</button>
    ${chips ? `<div class="name-chips-label">ຫຼືເລືອກຊື່ທີ່ເຄີຍລົງທະບຽນ:</div>${chips}` : ""}
    <button class="link-btn" id="rosterLinkBtn">📋 ລາຍຊື່ນັກຮຽນ ແລະ ຄະແນນ (ສຳລັບຄູ/ແອັດມິນ)</button>
  `;

  const input = document.getElementById("nameInput");
  const start = () => {
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    setCurrentStudent(input.value);
    navigate("#/home");
  };
  document.getElementById("nameStartBtn").addEventListener("click", start);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") start();
  });
  app.querySelectorAll(".name-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      setCurrentStudent(chip.dataset.name);
      navigate("#/home");
    });
  });
  document.getElementById("rosterLinkBtn").addEventListener("click", () => navigate("#/students"));
}

// ---------- Admin PIN gate ----------
function renderAdminGate(targetHash) {
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ສຳລັບແອັດມິນ";

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
    if (input.value === ADMIN_PIN) {
      sessionStorage.setItem(ADMIN_UNLOCK_KEY, "1");
      // navigate() is a no-op when already on targetHash (no hashchange fires for an
      // identical URL), which is the common case here — re-render directly instead.
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

  const lessons = getLessons();
  const students = loadStudents();
  const names = Object.keys(students).sort((a, b) => a.localeCompare(b, "lo"));

  const rows = names.map((name) => {
    const prog = students[name] || {};
    const lessonBadges = lessons.map((lesson) => {
      const lp = prog[lesson.id];
      if (!lp || (!lp.viewed && !lp.bestTotal)) return `<span class="mini-badge not-started" title="${lesson.title_lo}">${lesson.icon}</span>`;
      if (lp.passed) return `<span class="mini-badge passed" title="${lesson.title_lo}: ${lp.bestScore}/${lp.bestTotal}">${lesson.icon}✓</span>`;
      if (lp.bestTotal) return `<span class="mini-badge failed" title="${lesson.title_lo}: ${lp.bestScore}/${lp.bestTotal}">${lesson.icon}✕</span>`;
      return `<span class="mini-badge in-progress" title="${lesson.title_lo}">${lesson.icon}</span>`;
    }).join("");
    const passedCount = lessons.filter((l) => prog[l.id] && prog[l.id].passed).length;
    return `
      <div class="roster-row">
        <div class="roster-name">${name}</div>
        <div class="roster-badges">${lessonBadges}</div>
        <div class="roster-summary">${passedCount}/${lessons.length} ບົດຜ່ານ</div>
      </div>`;
  }).join("");

  const editLinks = lessons.map((l, i) => `<button class="lesson-edit-btn" data-id="${l.id}">✏️ ${i + 1}. ${l.title_lo}</button>`).join("");

  app.innerHTML = `
    <div class="intro">
      <h2>ລາຍຊື່ນັກຮຽນ 📋</h2>
      <p>ຮ່ວມທັງໝົດ ${names.length} ຄົນ. ໄອຄອນສີຂຽວ = ຜ່ານ, ສີແດງ = ຍັງບໍ່ຜ່ານ, ສີເທົາ = ຍັງບໍ່ໄດ້ຮຽນ.</p>
    </div>
    ${names.length ? `<div class="roster-list">${rows}</div>` : '<div class="empty-msg">ຍັງບໍ່ມີນັກຮຽນລົງທະບຽນ</div>'}

    <div class="admin-tools">
      <h3>✏️ ແກ້ໄຂບົດຮຽນ</h3>
      <p class="admin-hint">ເລືອກບົດຮຽນເພື່ອແກ້ໄຂ, ເພີ່ມ, ຫຼືລຶບຄຳສັບ/ປະໂຫຍກ.</p>
      <div class="edit-links">${editLinks}</div>
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

    <button class="link-btn" id="lockAdminBtn">🔒 ອອກຈາກໂໝດແອັດມິນ</button>
  `;

  app.querySelectorAll(".lesson-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigate("#/edit/" + btn.dataset.id));
  });
  document.getElementById("exportDataBtn").addEventListener("click", exportDataJs);
  document.getElementById("exportBackupBtn").addEventListener("click", exportOverridesBackup);
  document.getElementById("importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importOverridesBackup(e.target.files[0]);
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
  const merged = getLessons();
  const js = "// Transcribed content from the Korean-Lao textbook for seasonal workers.\nconst LESSONS = " + JSON.stringify(merged, null, 2) + ";\n";
  downloadTextFile("data.js", js);
}
function exportOverridesBackup() {
  downloadTextFile("kolo_content_overrides_backup.json", JSON.stringify(loadOverrides(), null, 2));
}
function importOverridesBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      saveOverrides(data);
      alert("ນຳເຂົ້າສຳເລັດແລ້ວ!");
      render();
    } catch (e) {
      alert("ໄຟລ໌ບໍ່ຖືກຕ້ອງ, ກະລຸນາລອງໃໝ່.");
    }
  };
  reader.readAsText(file);
}

// ---------- Home view ----------
function renderHome() {
  backBtn.classList.add("hidden");
  topTitle.textContent = "ຮຽນພາສາເກົາຫຼີ";

  const lessons = getLessons();
  const cards = lessons.map((lesson, i) => {
    const prog = getLessonProgress(lesson.id);
    let badge = '<span class="badge not-started">ຍັງບໍ່ໄດ້ຮຽນ</span>';
    if (prog.passed) {
      badge = `<span class="badge passed">ຜ່ານ ${prog.bestScore}/${prog.bestTotal}</span>`;
    } else if (prog.bestTotal > 0) {
      badge = `<span class="badge failed">ຄະແນນ ${prog.bestScore}/${prog.bestTotal}</span>`;
    } else if (prog.viewed) {
      badge = '<span class="badge in-progress">ກຳລັງຮຽນ</span>';
    }
    const itemCount = allItems(lesson).length;
    return `
      <div class="lesson-card" data-id="${lesson.id}">
        <div class="lesson-icon">${lesson.icon || "📘"}</div>
        <div class="lesson-info">
          <div class="title-lo">${i + 1}. ${lesson.title_lo}</div>
          <div class="title-ko ko">${lesson.title_ko || ""}</div>
          <div class="meta">${itemCount} ຄຳ/ປະໂຫຍກ</div>
        </div>
        ${badge}
      </div>`;
  }).join("");

  app.innerHTML = `
    <div class="intro">
      <h2>ສະບາຍດີ 👋</h2>
      <p>ຮຽນຄຳສັບ ແລະ ປະໂຫຍກພາສາເກົາຫຼີທີ່ຈຳເປັນສຳລັບແຮງງານລະດູການ. ອ່ານຄຳອ່ານພາສາລາວ ຟັງສຽງ ແລ້ວທົດລອງເຮັດແບບທົດສອບຫຼັງຈົບແຕ່ລະບົດ.</p>
    </div>
    <div class="lesson-list">${cards}</div>
    <button class="link-btn" id="rosterLinkBtn">📋 ລາຍຊື່ນັກຮຽນ ແລະ ຄະແນນ (ສຳລັບຄູ/ແອັດມິນ)</button>
  `;

  app.querySelectorAll(".lesson-card").forEach((el) => {
    el.addEventListener("click", () => navigate("#/lesson/" + el.dataset.id));
  });
  document.getElementById("rosterLinkBtn").addEventListener("click", () => navigate("#/students"));
}

// ---------- Lesson view ----------
function renderLesson(lessonId) {
  const lesson = findLesson(lessonId);
  if (!lesson) return navigate("#/home");
  backBtn.classList.remove("hidden");
  topTitle.textContent = lesson.title_lo;
  setLessonProgress(lessonId, { viewed: true });

  const navChips = lesson.sections
    .map((s, i) => (s.title_lo ? { title: s.title_lo, id: `sec-${i}` } : null))
    .filter(Boolean);

  const sectionsHtml = lesson.sections.map((section, i) => {
    const itemsHtml = section.items.map((item) => {
      if (!item.korean && !item.lao_phonetic) {
        // Info-only item (e.g. emergency contact directory row) — no pronunciation to teach.
        return `
      <div class="vocab-card">
        <div class="vocab-meaning">${item.lao_meaning}</div>
      </div>`;
      }
      return `
      <div class="vocab-card">
        <div class="vocab-row">
          <div class="vocab-main">
            <div class="vocab-phonetic">${item.lao_phonetic || ""}</div>
            ${item.korean ? `<div class="vocab-korean ko">${item.korean}</div>` : ""}
          </div>
          ${item.korean ? `<button class="speak-btn" data-text="${escapeAttr(item.korean)}" aria-label="ຟັງສຽງ">🔊</button>` : ""}
        </div>
        <div class="vocab-meaning">
          <span class="label">ຄວາມໝາຍ:</span>${item.lao_meaning}
        </div>
        ${item.note ? `<div class="vocab-note">${item.note}</div>` : ""}
        ${item.boss_korean_phonetic ? `<div class="vocab-boss">ນາຍຈ້າງເວົ້າວ່າ: ${item.boss_korean_phonetic}</div>` : ""}
      </div>`;
    }).join("");

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
      <button class="btn-secondary" id="backHomeBtn">← ກັບໄປໜ້າຫຼັກ</button>
    </div>
  `;

  app.querySelectorAll(".speak-btn").forEach((btn) => {
    btn.addEventListener("click", () => speak(btn.dataset.text));
  });
  app.querySelectorAll(".section-nav-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const el = document.getElementById(chip.dataset.target);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.getElementById("startQuizBtn").addEventListener("click", () => navigate("#/quiz/" + lessonId));
  document.getElementById("backHomeBtn").addEventListener("click", () => navigate("#/home"));
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// ---------- Quiz view ----------
let quizState = null;

function buildQuiz(lesson) {
  const items = allItems(lesson);
  const questionable = items.filter((it) => it.korean);
  const otherLessonItems = getLessons().filter((l) => l.id !== lesson.id).flatMap(allItems);
  const pool = shuffle(questionable).slice(0, Math.min(10, questionable.length));

  const questions = pool.map((correctItem) => {
    const distractSource = shuffle(
      items.filter((it) => it.lao_meaning !== correctItem.lao_meaning)
    );
    let distractors = distractSource.slice(0, 3);
    if (distractors.length < 3) {
      const extra = shuffle(otherLessonItems.filter((it) => it.lao_meaning !== correctItem.lao_meaning));
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

function renderQuiz(lessonId) {
  const lesson = findLesson(lessonId);
  if (!lesson) return navigate("#/home");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ແບບທົດສອບ";

  if (!quizState || quizState.lessonId !== lessonId) {
    quizState = {
      lessonId,
      questions: buildQuiz(lesson),
      index: 0,
      score: 0,
      answered: false,
    };
  }
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const { questions, index, score } = quizState;
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
function renderResult(lessonId, score, total) {
  const lesson = findLesson(lessonId);
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
      <button class="btn-secondary" id="homeBtn">🏠 ໜ້າຫຼັກ</button>
    </div>
  `;

  document.getElementById("retryBtn").addEventListener("click", () => {
    quizState = null;
    navigate("#/quiz/" + lessonId);
  });
  document.getElementById("reviewBtn").addEventListener("click", () => navigate("#/lesson/" + lessonId));
  document.getElementById("homeBtn").addEventListener("click", () => navigate("#/home"));
}

// ---------- Admin: edit lesson content ----------
let editDraft = null;

function renderEdit(lessonId) {
  const lesson = getLessons().find((l) => l.id === lessonId);
  if (!lesson) return navigate("#/students");
  backBtn.classList.remove("hidden");
  topTitle.textContent = "ແກ້ໄຂ: " + lesson.title_lo;

  editDraft = {
    lessonId,
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
      <p>ແກ້ໄຂ, ເພີ່ມ, ຫຼືລຶບຄຳສັບ/ປະໂຫຍກຂອງບົດຮຽນນີ້. ການປ່ຽນແປງຈະຖືກບັນທຶກໄວ້ໃນເຄື່ອງນີ້ທັນທີທີ່ກົດ "ບັນທຶກ".</p>
    </div>
    <div class="edit-field-row">
      <div class="edit-field">
        <label>ໄອຄອນ</label>
        <input id="editIcon" type="text" value="${escapeAttr(editDraft.icon)}" />
      </div>
      <div class="edit-field wide">
        <label>ຊື່ບົດຮຽນ (ພາສາລາວ)</label>
        <input id="editTitleLo" type="text" value="${escapeAttr(editDraft.title_lo)}" />
      </div>
      <div class="edit-field wide">
        <label>ຊື່ບົດຮຽນ (ພາສາເກົາຫຼີ)</label>
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
    editDraft.items.push({ section_lo: null, section_ko: null, korean: "", lao_phonetic: "", lao_meaning: "", boss_korean_phonetic: "" });
    renderEditView();
    const rows = document.querySelectorAll(".edit-row");
    if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.getElementById("saveEditBtn").addEventListener("click", saveEditDraft);
  document.getElementById("resetEditBtn").addEventListener("click", () => {
    if (!confirm("ຄືນຄ່າບົດຮຽນນີ້ກັບຄືນຄ່າເດີມ ແລະ ຍົກເລີກການແກ້ໄຂທັງໝົດບໍ?")) return;
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
    rowEl.querySelector(".f-korean").addEventListener("input", (e) => { editDraft.items[idx].korean = e.target.value; });
    rowEl.querySelector(".f-phonetic").addEventListener("input", (e) => { editDraft.items[idx].lao_phonetic = e.target.value; });
    rowEl.querySelector(".f-meaning").addEventListener("input", (e) => { editDraft.items[idx].lao_meaning = e.target.value; });
    rowEl.querySelector(".f-boss").addEventListener("input", (e) => { editDraft.items[idx].boss_korean_phonetic = e.target.value; });
    rowEl.querySelector(".delete-row").addEventListener("click", () => {
      if (editDraft.items.length <= 1) {
        alert("ຕ້ອງມີຢ່າງໜ້ອຍ 1 ລາຍການ");
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

function saveEditDraft() {
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
  alert("ບັນທຶກສຳເລັດແລ້ວ!");
  navigate("#/students");
}
