// firebase-shared.js
// Module partagé par index.html, carrousel.html, visuel.html et admin.html.
// Expose window.CS avec toutes les fonctions Auth / Firestore nécessaires,
// puis dispatch l'événement "cs:ready" une fois prêt.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  getDocs,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDU6p2I33OabJxelBm7gMhwB8TY_CBUnZc",
  authDomain: "carrousel-studio.firebaseapp.com",
  projectId: "carrousel-studio",
  storageBucket: "carrousel-studio.firebasestorage.app",
  messagingSenderId: "439571617867",
  appId: "1:439571617867:web:7485041698a7be4d3655ce",
  measurementId: "G-PZ2WPH23CL",
};

const ADMIN_EMAIL = "hodler1206@gmail.com";
const DEFAULT_PLAN = "genesis";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function userDocRef(uid) {
  return doc(db, "users", uid);
}

/* ---------- Compte utilisateur ---------- */

async function ensureUserDoc(user) {
  const ref = userDocRef(user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const data = {
      email: user.email,
      planId: DEFAULT_PLAN,
      planSource: "default",
      promoCode: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(ref, data);
    return data;
  }
  return snap.data();
}

function listenUserDoc(uid, cb) {
  return onSnapshot(userDocRef(uid), (snap) => {
    if (snap.exists()) cb(snap.data());
  });
}

async function setUserPlan(uid, planId, source = "self") {
  await updateDoc(userDocRef(uid), {
    planId,
    planSource: source,
    updatedAt: serverTimestamp(),
  });
}

// Nom/prénom saisis sur la fiche d'activation d'un forfait payant — utile
// pour recouper avec les échanges WhatsApp côté admin.
async function updateContactInfo(uid, { firstName, lastName }) {
  await updateDoc(userDocRef(uid), {
    firstName: firstName || null,
    lastName: lastName || null,
    updatedAt: serverTimestamp(),
  });
}

/* ---------- Authentification (email + mot de passe) ---------- */

async function signUpWithPassword(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

async function signInWithPassword(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

// Conservé pour compatibilité : les pages appellent encore cette fonction
// au chargement. Il n'y a plus de lien magique à finaliser, donc no-op.
async function completeSignInIfLink() {
  return null;
}

function onAuthChange(cb) {
  return onAuthStateChanged(auth, cb);
}

/* ---------- Pont XBooster (2 oct. 2026) ---------- */
// Appelé depuis accueil.html quand la page est ouverte avec ?xb=<jeton>
// (lancée depuis le dashboard XBooster). Échange le jeton contre une
// connexion Firebase + un forfait automatiquement aligné sur le palier
// réel du membre — voir api/xbooster-bridge.js pour la vérification
// serveur (signature, anti-rejeu).
async function signInWithXBoosterBridge(token) {
  const response = await fetch("/api/xbooster-bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Connexion depuis XBooster impossible.");
  }
  const result = await signInWithCustomToken(auth, data.customToken);
  return result.user;
}

function signOutUser() {
  return signOut(auth);
}

function isAdmin(user) {
  return !!user && user.email === ADMIN_EMAIL;
}

/* ---------- Codes promo ---------- */

async function redeemPromoCode(uid, rawCode) {
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) throw new Error("Code vide.");
  const promoRef = doc(db, "promoCodes", code);
  const userRef = userDocRef(uid);
  return runTransaction(db, async (tx) => {
    const promoSnap = await tx.get(promoRef);
    if (!promoSnap.exists()) throw new Error("Ce code promo n'existe pas.");
    const promo = promoSnap.data();
    if (promo.active === false) throw new Error("Ce code promo n'est plus actif.");
    if (promo.expiresAt && promo.expiresAt.toDate && promo.expiresAt.toDate() < new Date()) {
      throw new Error("Ce code promo a expiré.");
    }
    const usedCount = promo.usedCount || 0;
    if (promo.maxUses && usedCount >= promo.maxUses) {
      throw new Error("Ce code promo a atteint sa limite d'utilisation.");
    }
    tx.update(promoRef, { usedCount: usedCount + 1 });
    tx.update(userRef, {
      planId: promo.planId,
      planSource: "promo",
      promoCode: code,
      updatedAt: serverTimestamp(),
    });
    return promo.planId;
  });
}

/* ---------- Admin ---------- */

async function adminListUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

async function adminSetUserPlan(uid, planId) {
  await updateDoc(userDocRef(uid), {
    planId,
    planSource: "admin",
    updatedAt: serverTimestamp(),
  });
}

async function adminDeleteUser(uid) {
  // Supprime uniquement le document Firestore (forfait/quota) — pas le
  // compte de connexion Firebase Auth, qui nécessite un accès Admin SDK
  // côté serveur et ne peut pas être supprimé pour autrui depuis le client.
  await deleteDoc(userDocRef(uid));
}

async function adminListPromoCodes() {
  const snap = await getDocs(collection(db, "promoCodes"));
  return snap.docs.map((d) => ({ code: d.id, ...d.data() }));
}

async function adminCreatePromoCode(code, data) {
  const cleanCode = code.trim().toUpperCase();
  const ref = doc(db, "promoCodes", cleanCode);
  await setDoc(ref, {
    planId: data.planId,
    maxUses: data.maxUses || null,
    usedCount: 0,
    active: true,
    expiresAt: data.expiresAt || null,
    createdAt: serverTimestamp(),
  });
  return cleanCode;
}

async function adminSetPromoActive(code, active) {
  await updateDoc(doc(db, "promoCodes", code), { active });
}

window.CS = {
  auth,
  db,
  ADMIN_EMAIL,
  ensureUserDoc,
  listenUserDoc,
  setUserPlan,
  updateContactInfo,
  signUpWithPassword,
  signInWithPassword,
  completeSignInIfLink,
  onAuthChange,
  signOutUser,
  signInWithXBoosterBridge,
  isAdmin,
  redeemPromoCode,
  adminListUsers,
  adminSetUserPlan,
  adminDeleteUser,
  adminListPromoCodes,
  adminCreatePromoCode,
  adminSetPromoActive,
};

window.dispatchEvent(new CustomEvent("cs:ready"));
