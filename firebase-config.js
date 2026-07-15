// Shared cloud database for the official exam (enable/disable toggle, question
// bank, and results) so every device — phone, tablet, computer — sees the same
// state in real time instead of each browser's own separate localStorage.
const firebaseConfig = {
  apiKey: "AIzaSyCeD66falLJl0_9nOTy_hv6jLUrnZc9xPU",
  authDomain: "korean-lao-exam.firebaseapp.com",
  projectId: "korean-lao-exam",
  storageBucket: "korean-lao-exam.firebasestorage.app",
  messagingSenderId: "125122585513",
  appId: "1:125122585513:web:8a5c5e923dc02f2e175ab8",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
