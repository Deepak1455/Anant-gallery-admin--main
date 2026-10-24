// ==========================================================================
// ANANT ADMIN CONSOLE - FULL REAL-TIME ENGINE (UPDATED & SECURED)
// ==========================================================================

import { auth, db } from "./firebase-config.js";
import {
    signInAnonymously,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    GoogleAuthProvider,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection,
    collectionGroup,
    onSnapshot,
    doc,
    deleteDoc,
    writeBatch,
    getDocs,
    setDoc,
    query,
    where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Master Pin Cryptographic Salt
const SALT = "anant_master_admin_vault_2026";
const DEFAULT_PIN = "998877";
const PASSKEY_ID_KEY = "anant_admin_passkey_id";
const AUTHORIZED_ADMINS = [
    "dt8484970@gmail.com",
    "dt4527129@gmail.com",
    "ffdeepak4527@gmail.com",
    "anantgalleryogr@gmail.com"
];

let currentTab = "dashboard";
let userFilter = "";
let photosData = [];
let fallbackPhotosData = [];
let albumsData = [];
let usersProfileData = {};
let appConfigData = { ads_enabled: true, maintenance_mode: false };
let firestoreError = null;
const firestoreErrors = {};
let unsubscribePhotoFallback = null;
let realtimeStreamStarted = false;
let unauthorizedSignOutInProgress = false;
let isPurgingTrash = false;
let lightboxPhotoPath = null;
let lightboxZoom = 1;

function isAuthorizedAdmin(user) {
    return Boolean(user?.email && AUTHORIZED_ADMINS.includes(user.email.trim().toLowerCase()));
}

function getGoogleAuthErrorMessage(error) {
    if (error?.code === "auth/unauthorized-domain") {
        return "Unauthorized domain. Add anant-gallery-admin-main.vercel.app under Firebase Console > Authentication > Settings > Authorized domains.";
    }
    if (/redirect_uri_mismatch/i.test(error?.message || "")) {
        return "Google OAuth redirect URI mismatch. In Google Cloud Console, add https://my-photo-d96e9.firebaseapp.com/__/auth/handler as an authorized redirect URI for the OAuth web client used by Firebase Authentication.";
    }
    return `Google sign-in failed: ${error?.message || "Unknown authentication error"}`;
}

async function rejectUnauthorizedUser() {
    if (unauthorizedSignOutInProgress) return;
    unauthorizedSignOutInProgress = true;
    try {
        await signOut(auth);
    } catch (error) {
        toast(`Unable to sign out unauthorized account: ${error.message}`);
    } finally {
        toast("Access Denied: Unauthorized Email");
        unauthorizedSignOutInProgress = false;
    }
}

function showAdminWorkspace(message = "Admin Access Granted") {
    document.getElementById("adminLockScreen").style.display = "none";
    document.getElementById("adminWorkspace").style.display = "flex";
    if (realtimeStreamStarted) return;
    realtimeStreamStarted = true;
    if (message) toast(message);
    startRealtimeStream();
}

function watchAdminAuthState() {
    onAuthStateChanged(auth, async user => {
        if (!user || user.isAnonymous) return;
        if (isAuthorizedAdmin(user)) {
            showAdminWorkspace(`Admin Verified: ${user.email}`);
            return;
        }

        await rejectUnauthorizedUser();
    }, error => {
        toast(`Authentication state error: ${error.message}`);
    });
}

// URL Sanitizer (Prepends base URL if relative path)
function sanitizeImageUrl(url) {
    if (typeof url !== "string" || !url) return "https://via.placeholder.com/50";
    if (url.startsWith("/api/")) {
        url = `https://anant-gallery.vercel.app${url}`;
    }
    try {
        const safeUrl = new URL(url, window.location.origin);
        return ["http:", "https:"].includes(safeUrl.protocol) ? safeUrl.href : "https://via.placeholder.com/50";
    } catch {
        return "https://via.placeholder.com/50";
    }
}

function getPhotoImage(photo) {
    return sanitizeImageUrl(photo.image || photo.imageUrl || photo.photoUrl || photo.url);
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function inlineArg(value) {
    return escapeHtml(JSON.stringify(String(value ?? "")));
}

function getAllPhotos() {
    return [...photosData, ...fallbackPhotosData];
}

function reportFirestoreError(error, source = "firestore") {
    const code = error?.code || "";
    if (code === "permission-denied") {
        firestoreErrors[source] = {
            title: "Firestore access denied",
            details: "Sign in with an authorized Google account. In Firebase Console, enable Google under Authentication > Sign-in method and add this site to Authentication > Settings > Authorized domains. Update Firestore Security Rules for user_photos, users, user_albums, and app_config/global to authorize only trusted admins (prefer a server-managed admin custom claim). The local PIN/passkey fallback signs in anonymously and cannot read protected admin data unless the rules explicitly allow it; do not grant broad access to anonymous users. Confirm the project is my-photo-d96e9 and the collection paths are correct."
        };
    } else if (["unavailable", "deadline-exceeded", "network-request-failed"].includes(code) ||
        /network|offline|unavailable/i.test(error?.message || "")) {
        firestoreErrors[source] = {
            title: "Firestore network error",
            details: "Check this device's internet connection, Firebase service status, and whether your network allows connections to Firestore. Then use Refresh to retry."
        };
    } else {
        firestoreErrors[source] = {
            title: "Firestore request failed",
            details: error?.message || "Check Firebase configuration and Firestore Security Rules, then retry."
        };
    }
    firestoreError = Object.values(firestoreErrors)[0] || null;
    renderCurrentTab();
}

function clearFirestoreError(source) {
    delete firestoreErrors[source];
    firestoreError = Object.values(firestoreErrors)[0] || null;
}

// SHA-256 Hasher
async function hashPin(pin) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pin + SALT);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Toast Notification (Clean, No Emojis)
function toast(msg) {
    const t = document.getElementById("adminToast");
    if (!t) return;
    t.innerText = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2800);
}

// Confirmation Dialog Modal
function confirmAction(title, desc, onConfirm, confirmLabel = "Confirm") {
    const modal = document.getElementById("adminModal");
    if (!modal) {
        if (confirm(title + "\n" + desc)) {
            if (onConfirm) onConfirm();
        }
        return;
    }
    document.getElementById("modalTitle").innerText = title;
    document.getElementById("modalDesc").innerText = desc;
    document.getElementById("btnModalConfirm").innerText = confirmLabel;
    modal.style.display = "flex";

    const close = () => { modal.style.display = "none"; };
    document.getElementById("btnModalCancel").onclick = close;
    document.getElementById("btnModalConfirm").onclick = () => {
        close();
        if (onConfirm) onConfirm();
    };
}

function formatSize(bytes) {
    if (!bytes) return "0 MB";
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(value) {
    if (!value) return "Unknown date";
    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}

function getPhotoPath(photo) {
    return photo.path || `user_photos/${photo.id}`;
}

function copyControl(value, label) {
    const text = String(value ?? "");
    return `
        <span class="copy-value">
            <span class="truncate-value" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
            <button class="copy-btn" type="button" title="Copy ${escapeHtml(label)}" aria-label="Copy ${escapeHtml(label)}"
                onclick="window.adminCopy(${inlineArg(text)}, ${inlineArg(label)})">
                <i class="fa-regular fa-copy" aria-hidden="true"></i>
            </button>
        </span>
    `;
}

function photoStatus(photo) {
    return `<span class="tag ${photo.isDeleted ? "trash" : (photo.isHidden ? "hidden" : "active")}">${photo.isDeleted ? "Trash" : (photo.isHidden ? "Private" : "Active")}</span>`;
}

function photoCard(photo) {
    const path = getPhotoPath(photo);
    const uid = photo.uid || "Anonymous";
    const date = photo.createdAt || photo.timestamp || photo.date || photo.uploadedAt;
    return `
        <article class="data-card photo-card">
            <button class="photo-card-image" type="button" onclick="window.adminPreviewPhoto(${inlineArg(path)})" aria-label="Preview photo ${escapeHtml(photo.id)}">
                <img src="${escapeHtml(getPhotoImage(photo))}" alt="" loading="lazy" onerror="this.src='https://via.placeholder.com/120?text=Photo'">
            </button>
            <div class="data-card-body">
                <div class="data-card-heading">${photoStatus(photo)}</div>
                <div class="data-field"><span>Photo ID</span>${copyControl(photo.id, "photo ID")}</div>
                <div class="data-field"><span>User UID</span>${copyControl(uid, "user UID")}</div>
                <div class="data-card-stats"><span>${formatSize(photo.fileSize || 0)}</span><span>${escapeHtml(formatDate(date))}</span></div>
                <div class="data-card-actions">
                    <button class="secondary-action" type="button" onclick="window.adminPreviewPhoto(${inlineArg(path)})"><i class="fa-solid fa-eye"></i> Preview</button>
                    <button class="action-btn del" type="button" aria-label="Delete photo" onclick="window.adminDeletePhoto(${inlineArg(path)})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        </article>
    `;
}

// --------------------------------------------------------------------------
// 1. SECURITY, MASTER PIN & FINGERPRINT WEBAUTHN
// --------------------------------------------------------------------------
async function initAuth() {
    let savedHash = localStorage.getItem("anant_admin_hash");
    if (!savedHash) {
        savedHash = await hashPin(DEFAULT_PIN);
        localStorage.setItem("anant_admin_hash", savedHash);
    }

    const pinInput = document.getElementById("adminMasterPin");
    const unlockBtn = document.getElementById("btnAdminUnlock");
    const bioBtn = document.getElementById("btnAdminBio");
    const googleBtn = document.getElementById("btnAdminGoogleLogin");

    const unlockWithPinOrPasskey = async () => {
        try {
            if (auth.currentUser && !auth.currentUser.isAnonymous && !isAuthorizedAdmin(auth.currentUser)) {
                await signOut(auth);
            }
            if (!auth.currentUser) await signInAnonymously(auth);
        } catch (error) {
            toast(`Firebase sign-in failed: ${error.message}. Enable Anonymous sign-in in Firebase Console.`);
            return;
        }
        showAdminWorkspace("Admin Access Granted");
    };

    if (googleBtn) {
        googleBtn.onclick = async () => {
            const provider = new GoogleAuthProvider();
            provider.setCustomParameters({ prompt: "select_account" });
            try {
                const result = await signInWithPopup(auth, provider);
                if (!isAuthorizedAdmin(result.user)) {
                    await rejectUnauthorizedUser();
                    return;
                }
                showAdminWorkspace(`Admin Verified: ${result.user.email}`);
            } catch (error) {
                if (error.code === "auth/popup-blocked") {
                    try {
                        await signInWithRedirect(auth, provider);
                    } catch (redirectError) {
                        toast(getGoogleAuthErrorMessage(redirectError));
                    }
                    return;
                }
                if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") {
                    toast("Google sign-in was cancelled");
                    return;
                }
                toast(getGoogleAuthErrorMessage(error));
            }
        };
    };

    if (unlockBtn) {
        unlockBtn.onclick = async () => {
            const pin = pinInput.value.trim();
            if (!pin) return toast("Enter 6-digit Master PIN");
            const enteredHash = await hashPin(pin);
            if (enteredHash === savedHash) {
                await unlockWithPinOrPasskey();
            } else {
                toast("Invalid Security PIN");
                pinInput.value = "";
            }
        };
    }

    if (pinInput) {
        pinInput.onkeydown = (e) => { if (e.key === "Enter") unlockBtn.click(); };
    }

    // FINGERPRINT WEBAUTHN (REGISTER & VERIFY)
    if (window.PublicKeyCredential && bioBtn) {
        bioBtn.onclick = async () => {
            const storedCredentialId = localStorage.getItem(PASSKEY_ID_KEY);

            if (!storedCredentialId) {
                try {
                    toast("Register your device passkey to continue");
                    const challenge = new Uint8Array(32);
                    crypto.getRandomValues(challenge);
                    const userId = new Uint8Array(16);
                    crypto.getRandomValues(userId);

                    const credential = await navigator.credentials.create({
                        publicKey: {
                            challenge: challenge,
                            rp: { name: "Anant Gallery Admin", id: window.location.hostname },
                            user: {
                                id: userId,
                                name: "admin@anantgallery.com",
                                displayName: "Master Admin"
                            },
                            pubKeyCredParams: [
                                { type: "public-key", alg: -7 },
                                { type: "public-key", alg: -257 }
                            ],
                            authenticatorSelection: {
                                authenticatorAttachment: "platform",
                                userVerification: "required"
                            },
                            timeout: 60000
                        }
                    });

                    if (!(credential instanceof PublicKeyCredential)) {
                        toast("Passkey registration did not complete. Use your PIN.");
                        return;
                    }
                    localStorage.setItem(PASSKEY_ID_KEY, btoa(String.fromCharCode(...new Uint8Array(credential.rawId))));
                    toast("Passkey registered");
                    await unlockWithPinOrPasskey();
                } catch (error) {
                    toast(`Passkey registration failed: ${error.message}. Use your PIN.`);
                }
            } else {
                try {
                    const challenge = new Uint8Array(32);
                    crypto.getRandomValues(challenge);
                    const credentialId = Uint8Array.from(atob(storedCredentialId), character => character.charCodeAt(0));
                    const credential = await navigator.credentials.get({
                        publicKey: {
                            challenge: challenge,
                            timeout: 30000,
                            rpId: window.location.hostname,
                            allowCredentials: [{ type: "public-key", id: credentialId }],
                            userVerification: "required"
                        }
                    });
                    if (credential instanceof PublicKeyCredential) {
                        await unlockWithPinOrPasskey();
                    } else {
                        toast("Passkey verification did not complete. Enter your PIN.");
                    }
                } catch (error) {
                    toast(`Passkey verification failed: ${error.message}. Enter your PIN.`);
                }
            }
        };
    } else if (bioBtn) {
        bioBtn.disabled = true;
        bioBtn.title = "Passkeys are not supported in this browser";
    }
}

async function processGoogleRedirectResult() {
    try {
        const result = await getRedirectResult(auth);
        if (!result?.user) return;
        if (isAuthorizedAdmin(result.user)) {
            showAdminWorkspace(`Admin Verified: ${result.user.email}`);
        } else {
            await rejectUnauthorizedUser();
        }
    } catch (error) {
        toast(getGoogleAuthErrorMessage(error));
    }
}

// --------------------------------------------------------------------------
// 2. REALTIME FIRESTORE STREAM
// --------------------------------------------------------------------------
function startRealtimeStream() {
    // Photos Stream
    onSnapshot(collection(db, "user_photos"), (snap) => {
        clearFirestoreError("photos");
        photosData = [];
        snap.forEach(d => photosData.push({ id: d.id, path: d.ref.path, ...d.data() }));
        if (snap.empty && !unsubscribePhotoFallback) {
            unsubscribePhotoFallback = onSnapshot(collectionGroup(db, "photos"), fallbackSnap => {
                clearFirestoreError("photo-fallback");
                fallbackPhotosData = [];
                fallbackSnap.forEach(d => fallbackPhotosData.push({ id: d.id, path: d.ref.path, ...d.data() }));
                renderCurrentTab();
            }, error => reportFirestoreError(error, "photo-fallback"));
        } else if (!snap.empty) {
            fallbackPhotosData = [];
            if (unsubscribePhotoFallback) {
                unsubscribePhotoFallback();
                unsubscribePhotoFallback = null;
            }
        }
        renderCurrentTab();
    }, error => reportFirestoreError(error, "photos"));

    // Albums Stream
    onSnapshot(collection(db, "user_albums"), (snap) => {
        clearFirestoreError("albums");
        albumsData = [];
        snap.forEach(d => albumsData.push({ id: d.id, ...d.data() }));
        if (currentTab === "albums" || currentTab === "dashboard") {
            renderCurrentTab();
        }
    }, error => reportFirestoreError(error, "albums"));

    // User Profiles (for PRO tracking)
    onSnapshot(collection(db, "users"), (snap) => {
        clearFirestoreError("users");
        usersProfileData = {};
        snap.forEach(d => {
            usersProfileData[d.id] = d.data();
        });
        if (currentTab === "users" || currentTab === "dashboard") {
            renderCurrentTab();
        }
    }, error => reportFirestoreError(error, "users"));

    // Global App Remote Config
    onSnapshot(doc(db, "app_config", "global"), (snap) => {
        clearFirestoreError("config");
        if (snap.exists()) {
            appConfigData = snap.data();
        } else {
            appConfigData = { ads_enabled: true, maintenance_mode: false };
        }
        if (currentTab === "settings" || currentTab === "dashboard") {
            renderCurrentTab();
        }
    }, error => reportFirestoreError(error, "config"));
}

// --------------------------------------------------------------------------
// 3. TAB RENDERERS
// --------------------------------------------------------------------------
function renderCurrentTab() {
    const container = document.getElementById("contentContainer");
    if (!container) return;

    const activeElement = document.activeElement;
    const focusedInput = container.contains(activeElement) && activeElement instanceof HTMLInputElement
        ? { id: activeElement.id, start: activeElement.selectionStart, end: activeElement.selectionEnd }
        : null;

    if (currentTab === "dashboard") renderDashboard(container);
    else if (currentTab === "photos") renderPhotos(container);
    else if (currentTab === "users") renderUsers(container);
    else if (currentTab === "albums") renderAlbums(container);
    else if (currentTab === "settings") renderSettings(container);

    if (focusedInput?.id) {
        const replacement = document.getElementById(focusedInput.id);
        replacement?.focus({ preventScroll: true });
        if (replacement instanceof HTMLInputElement && focusedInput.start !== null && focusedInput.end !== null) {
            replacement.setSelectionRange(focusedInput.start, focusedInput.end);
        }
    }
}

// TAB 1: DASHBOARD
function renderDashboard(container) {
    const allPhotos = getAllPhotos();
    const totalPhotos = allPhotos.length;
    const inTrash = photosData.filter(p => p.isDeleted === true).length;
    const totalSize = allPhotos.reduce((a, b) => a + (b.fileSize || 3.5 * 1024 * 1024), 0);
    const usersCount = new Set([
        ...Object.keys(usersProfileData),
        ...allPhotos.map(p => p.uid).filter(Boolean)
    ]).size;
    const errorBanner = firestoreError ? `
        <div class="firestore-error" role="alert">
            <strong><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(firestoreError.title)}</strong>
            <p>${escapeHtml(firestoreError.details)}</p>
        </div>
    ` : "";

    container.innerHTML = `
        ${errorBanner}
        <div class="metrics-row">
            <div class="m-card">
                <div class="m-icon" style="background:linear-gradient(135deg,#4f46e5,#9333ea);"><i class="fa-solid fa-images"></i></div>
                <div class="m-info">
                    <h4>Total Photos</h4>
                    <div class="m-val">${totalPhotos}</div>
                </div>
            </div>
            <div class="m-card">
                <div class="m-icon" style="background:linear-gradient(135deg,#10b981,#059669);"><i class="fa-solid fa-hard-drive"></i></div>
                <div class="m-info">
                    <h4>Storage Used</h4>
                    <div class="m-val">${formatSize(totalSize)}</div>
                </div>
            </div>
            <div class="m-card">
                <div class="m-icon" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);"><i class="fa-solid fa-users"></i></div>
                <div class="m-info">
                    <h4>Total Users</h4>
                    <div class="m-val">${usersCount}</div>
                </div>
            </div>
            <div class="m-card">
                <div class="m-icon" style="background:linear-gradient(135deg,#ef4444,#dc2626);"><i class="fa-solid fa-trash"></i></div>
                <div class="m-info">
                    <h4>Trash Items</h4>
                    <div class="m-val">${inTrash}</div>
                </div>
            </div>
        </div>

        <div class="dashboard-actions">
            <div>
                <h3>Cloud trash</h3>
                <p>${inTrash} deleted ${inTrash === 1 ? "photo" : "photos"} ready to permanently remove</p>
            </div>
            <button class="danger-action" id="purgeTrashBtn" type="button" ${inTrash === 0 || isPurgingTrash ? "disabled" : ""}>
                <i class="fa-solid fa-trash-can"></i> ${isPurgingTrash ? "Emptying trash..." : "Empty Cloud Trash"}
            </button>
        </div>

        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-clock-rotate-left" style="color:var(--accent);"></i> Recent 8 Cloud Uploads</h3>
            </div>
            <div class="desktop-table-wrap">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Photo</th>
                            <th>Doc ID</th>
                            <th>User UID</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${allPhotos.slice(0, 8).map(p => `
                            <tr>
                                <td><button class="table-preview" type="button" onclick="window.adminPreviewPhoto(${inlineArg(getPhotoPath(p))})" aria-label="Preview photo ${escapeHtml(p.id)}"><img src="${escapeHtml(getPhotoImage(p))}" class="table-img" alt="" onerror="this.src='https://via.placeholder.com/50'"></button></td>
                                <td>${copyControl(p.id, "photo ID")}</td>
                                <td>${copyControl(p.uid || 'Anonymous', "user UID")}</td>
                                <td>${photoStatus(p)}</td>
                                <td>
                                    <button class="action-btn del" type="button" onclick="window.adminDeletePhoto(${inlineArg(getPhotoPath(p))})"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="mobile-card-list">
                ${allPhotos.length ? allPhotos.slice(0, 8).map(photoCard).join("") : '<p class="empty-state">No cloud photos yet.</p>'}
            </div>
        </div>
    `;
    document.getElementById("purgeTrashBtn")?.addEventListener("click", () => window.adminPurgeTrash());
}

// TAB 2: PHOTOS DIRECTORY
function renderPhotos(container) {
    const allPhotos = getAllPhotos();
    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-images" style="color:var(--accent);"></i> All Cloud Photos (${allPhotos.length})</h3>
                <div class="search-box">
                    <input type="search" id="photoFilter" placeholder="Search by photo ID or UID..." aria-label="Search photos by ID or user UID">
                </div>
            </div>
            <div class="desktop-table-wrap">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Preview</th>
                            <th>Doc ID</th>
                            <th>UID</th>
                            <th>Category</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="photoRows">
                        ${renderPhotoTableRows(allPhotos)}
                    </tbody>
                </table>
            </div>
            <div class="mobile-card-list" id="photoCards">${renderPhotoCards(allPhotos)}</div>
        </div>
    `;

    document.getElementById("photoFilter")?.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = getAllPhotos().filter(p => String(p.id).toLowerCase().includes(q) || String(p.uid || "").toLowerCase().includes(q));
        document.getElementById("photoRows").innerHTML = renderPhotoTableRows(filtered);
        document.getElementById("photoCards").innerHTML = renderPhotoCards(filtered);
    });
}

function renderPhotoCards(list) {
    return list.length ? list.map(photoCard).join("") : '<p class="empty-state">No photos found.</p>';
}

function renderPhotoTableRows(list) {
    if (list.length === 0) return `<tr><td colspan="5" style="text-align:center; padding:30px;">No photos found.</td></tr>`;
    return list.map(p => `
        <tr>
            <td><button class="table-preview" type="button" onclick="window.adminPreviewPhoto(${inlineArg(getPhotoPath(p))})" aria-label="Preview photo ${escapeHtml(p.id)}"><img src="${escapeHtml(getPhotoImage(p))}" class="table-img" alt="" onerror="this.src='https://via.placeholder.com/50'"></button></td>
            <td>${copyControl(p.id, "photo ID")}</td>
            <td>${copyControl(p.uid || 'Anonymous', "user UID")}</td>
            <td>${photoStatus(p)}</td>
            <td>
                <button class="action-btn" type="button" onclick="window.adminPreviewPhoto(${inlineArg(getPhotoPath(p))})"><i class="fa-solid fa-eye"></i></button>
                <button class="action-btn del" type="button" onclick="window.adminDeletePhoto(${inlineArg(getPhotoPath(p))})"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}

// TAB 3: USER MANAGEMENT & ANANT PRO CONTROLLER
function renderUsers(container) {
    const userMap = new Map();
    getAllPhotos().forEach(p => {
        if (!p.uid) return;
        if (!userMap.has(p.uid)) userMap.set(p.uid, { uid: p.uid, count: 0, trash: 0, bytes: 0 });
        const u = userMap.get(p.uid);
        if (p.isDeleted) u.trash++;
        else u.count++;
        u.bytes += (p.fileSize || 3.5 * 1024 * 1024);
    });

    // Merge registered auth users
    Object.keys(usersProfileData).forEach(uid => {
        if (!userMap.has(uid)) {
            userMap.set(uid, { uid: uid, count: 0, trash: 0, bytes: 0 });
        }
    });

    const userList = Array.from(userMap.values());

    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-users" style="color:var(--accent);"></i> Registered Users & Pro Membership (${userList.length})</h3>
                <div class="search-box">
                    <input type="search" id="userFilter" value="${escapeHtml(userFilter)}" placeholder="Search email or UID..." aria-label="Search users by email or UID">
                </div>
            </div>
            <div class="desktop-table-wrap">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>User UID / Email</th>
                            <th>Photos</th>
                            <th>Storage</th>
                            <th>Membership</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${userList.map(u => {
                            const profile = usersProfileData[u.uid] || {};
                            const isPro = profile.isPro === true;
                            const email = profile.email || "Email unavailable";
                            const searchValue = `${email} ${u.uid}`.toLowerCase();
                            return `
                                <tr data-user-search="${escapeHtml(searchValue)}">
                                    <td>
                                        <div class="user-identity">
                                            <strong>${copyControl(email, "email")}</strong>
                                            ${copyControl(u.uid, "user UID")}
                                        </div>
                                    </td>
                                    <td><span class="tag active">${u.count} Photos</span></td>
                                    <td>${formatSize(u.bytes)}</td>
                                    <td>
                                        <button class="membership-toggle tag ${isPro ? 'pro' : 'free'}" type="button"
                                            aria-label="${isPro ? 'Revoke Anant PRO' : 'Grant Anant PRO'} for ${escapeHtml(u.uid)}"
                                            onclick="window.adminTogglePro(${inlineArg(u.uid)}, ${!isPro})">
                                            ${isPro ? 'Anant PRO' : 'Free Tier'}
                                        </button>
                                    </td>
                                    <td>
                                        <button class="action-btn del" type="button" onclick="window.adminWipeUser(${inlineArg(u.uid)})" title="Wipe User Data" aria-label="Wipe data for ${escapeHtml(u.uid)}">
                                            <i class="fa-solid fa-trash-can"></i>
                                        </button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="mobile-card-list" id="userCards">
                ${userList.map(u => {
                    const profile = usersProfileData[u.uid] || {};
                    const isPro = profile.isPro === true;
                    const email = profile.email || "Email unavailable";
                    const searchValue = `${email} ${u.uid}`.toLowerCase();
                    return `
                        <article class="data-card user-card" data-user-search="${escapeHtml(searchValue)}">
                            <div class="data-card-heading">
                                <div class="user-card-title"><i class="fa-solid fa-user"></i><span>User account</span></div>
                                <button class="membership-toggle tag ${isPro ? 'pro' : 'free'}" type="button"
                                    aria-label="${isPro ? 'Revoke Anant PRO' : 'Grant Anant PRO'} for ${escapeHtml(u.uid)}"
                                    onclick="window.adminTogglePro(${inlineArg(u.uid)}, ${!isPro})">
                                    ${isPro ? 'Anant PRO' : 'Free Tier'}
                                </button>
                            </div>
                            <div class="data-field"><span>Email</span>${copyControl(email, "email")}</div>
                            <div class="data-field"><span>User UID</span>${copyControl(u.uid, "user UID")}</div>
                            <div class="user-stats">
                                <span><strong>${u.count}</strong> Photos</span>
                                <span><strong>${formatSize(u.bytes)}</strong> Storage</span>
                                <span><strong>${u.trash}</strong> Trash</span>
                            </div>
                            <div class="data-card-actions">
                                <button class="secondary-action" type="button" onclick="window.adminTogglePro(${inlineArg(u.uid)}, ${!isPro})">
                                    ${isPro ? "Revoke PRO" : "Grant PRO"}
                                </button>
                                <button class="action-btn del" type="button" onclick="window.adminWipeUser(${inlineArg(u.uid)})" aria-label="Wipe user data">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </article>
                    `;
                }).join("") || '<p class="empty-state">No registered users found.</p>'}
            </div>
        </div>
    `;

    document.getElementById("userFilter")?.addEventListener("input", event => {
        userFilter = event.target.value;
        const search = userFilter.toLowerCase().trim();
        container.querySelectorAll("[data-user-search]").forEach(item => {
            item.hidden = !item.dataset.userSearch.includes(search);
        });
    });
}

// TAB 4: ALBUMS
function renderAlbums(container) {
    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-folder-tree" style="color:var(--accent);"></i> All Cloud Albums (${albumsData.length})</h3>
            </div>
            <div class="desktop-table-wrap">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Album Name</th>
                            <th>Album ID</th>
                            <th>Owner UID</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${albumsData.map(a => `
                            <tr>
                                <td style="font-weight:700;"><i class="fa-solid fa-folder" style="color:var(--accent); margin-right:8px;"></i> ${escapeHtml(a.name)}</td>
                                <td>${copyControl(a.id, "album ID")}</td>
                                <td>${copyControl(a.uid || "Unknown", "owner UID")}</td>
                                <td>
                                    <button class="action-btn del" type="button" onclick="window.adminDeleteAlbum(${inlineArg(a.id)})"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="mobile-card-list">
                ${albumsData.map(a => `
                    <article class="data-card album-card">
                        <div class="data-card-heading"><span class="album-name"><i class="fa-solid fa-folder"></i> ${escapeHtml(a.name || "Untitled album")}</span><span class="tag active">Album</span></div>
                        <div class="data-field"><span>Album ID</span>${copyControl(a.id, "album ID")}</div>
                        <div class="data-field"><span>Owner UID</span>${copyControl(a.uid || "Unknown", "owner UID")}</div>
                        <div class="data-card-actions">
                            <button class="action-btn del" type="button" onclick="window.adminDeleteAlbum(${inlineArg(a.id)})" aria-label="Delete album"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </article>
                `).join("") || '<p class="empty-state">No albums found.</p>'}
            </div>
        </div>
    `;
}

// TAB 5: SYSTEM SETTINGS, REMOTE CONFIG & PIN
function renderSettings(container) {
    const isAdsOn = appConfigData.ads_enabled !== false;
    const isMaintOn = appConfigData.maintenance_mode === true;

    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-sliders" style="color:var(--accent);"></i> System Remote Config & Security</h3>
            </div>
            
            <div style="display:flex; flex-direction:column; gap:20px;">
                <!-- Global Remote Killswitches -->
                <div style="background:var(--bg-surface); padding:18px; border-radius:14px;">
                    <h4 style="margin-bottom:6px;">Global App Switches (Realtime)</h4>
                    <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:14px;">Toggle mobile app features instantly without releasing Play Store updates</p>
                    
                    <div style="display:flex; flex-wrap:wrap; gap:16px;">
                        <button class="btn-unlock" role="switch" aria-checked="${isAdsOn}" style="width:auto; padding:10px 20px; background:${isAdsOn ? '#10b981' : '#6b7280'};" onclick="window.adminToggleConfig('ads_enabled', ${!isAdsOn})">
                            <i class="fa-solid fa-rectangle-ad" style="margin-right:8px;"></i> ads_enabled: ${isAdsOn ? 'ENABLED' : 'DISABLED'}
                        </button>
                        <button class="btn-unlock" role="switch" aria-checked="${isMaintOn}" style="width:auto; padding:10px 20px; background:${isMaintOn ? '#ef4444' : '#374151'};" onclick="window.adminToggleConfig('maintenance_mode', ${!isMaintOn})">
                            <i class="fa-solid fa-triangle-exclamation" style="margin-right:8px;"></i> maintenance_mode: ${isMaintOn ? 'ACTIVE' : 'OFF'}
                        </button>
                    </div>
                </div>

                <!-- Biometric Re-register -->
                <div style="background:var(--bg-surface); padding:18px; border-radius:14px;">
                    <h4 style="margin-bottom:6px;">Biometric Passkey Configuration</h4>
                    <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:14px;">Reset device fingerprint authentication</p>
                    <button class="btn-unlock" style="width:auto; padding:10px 20px; background:#4f46e5;" id="btnResetBio">
                        <i class="fa-solid fa-fingerprint" style="margin-right:8px;"></i> Register New Fingerprint Passkey
                    </button>
                </div>

                <!-- Master PIN Change -->
                <div style="background:var(--bg-surface); padding:18px; border-radius:14px;">
                    <h4 style="margin-bottom:6px;">Change Master Security PIN</h4>
                    <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:14px;">Update admin access passkey (Default: 998877)</p>
                    <div style="display:flex; gap:10px;">
                        <input type="password" id="newPinInput" maxlength="6" placeholder="New 6-Digit PIN" style="padding:10px; border-radius:10px; background:var(--bg-card); border:1px solid var(--border); color:#fff; width:160px; text-align:center;">
                        <button class="btn-unlock" style="width:auto; padding:10px 18px;" id="btnSavePin">Update PIN</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById("btnSavePin")?.addEventListener("click", async () => {
        const val = document.getElementById("newPinInput").value.trim();
        if (val.length !== 6 || isNaN(val)) return toast("PIN must be 6 digits");
        const newHash = await hashPin(val);
        localStorage.setItem("anant_admin_hash", newHash);
        toast("Master PIN Updated");
        document.getElementById("newPinInput").value = "";
    });

    document.getElementById("btnResetBio")?.addEventListener("click", () => {
        localStorage.removeItem(PASSKEY_ID_KEY);
        toast("Passkey removed. Tap biometric button to register again.");
    });
}

// --------------------------------------------------------------------------
// 4. GLOBAL ACTION HANDLERS
// --------------------------------------------------------------------------
window.adminCopy = async (value, label = "value") => {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(String(value));
        } else {
            const input = document.createElement("textarea");
            input.value = String(value);
            input.setAttribute("readonly", "");
            input.style.position = "fixed";
            input.style.opacity = "0";
            document.body.appendChild(input);
            input.select();
            const copied = document.execCommand("copy");
            input.remove();
            if (!copied) throw new Error("Clipboard access is unavailable");
        }
        toast(`${label} copied`);
    } catch (error) {
        toast(`Unable to copy ${label}: ${error.message}`);
    }
};

window.adminPreviewPhoto = documentPath => {
    const photo = getAllPhotos().find(item => getPhotoPath(item) === documentPath);
    if (!photo) {
        toast("Photo is no longer available in the current stream");
        return;
    }
    const lightbox = document.getElementById("photoLightbox");
    if (!lightbox) return;
    lightboxPhotoPath = documentPath;
    lightboxZoom = 1;
    document.getElementById("lightboxImage").src = getPhotoImage(photo);
    document.getElementById("lightboxImage").style.transform = `scale(${lightboxZoom})`;
    document.getElementById("lightboxTitle").textContent = photo.id;
    document.getElementById("lightboxUid").textContent = photo.uid || "Anonymous";
    document.getElementById("lightboxSize").textContent = formatSize(photo.fileSize || 0);
    document.getElementById("lightboxDate").textContent = formatDate(photo.createdAt || photo.timestamp || photo.date || photo.uploadedAt);
    lightbox.hidden = false;
    document.getElementById("lightboxClose")?.focus();
};

window.adminTogglePro = async (uid, shouldBePro) => {
    confirmAction(
        shouldBePro ? "Grant Anant PRO?" : "Revoke Anant PRO?",
        `Change ${uid} to ${shouldBePro ? "Anant PRO" : "Free Tier"}? This updates the user's membership immediately.`,
        async () => {
            try {
                await setDoc(doc(db, "users", uid), { isPro: shouldBePro }, { merge: true });
                clearFirestoreError("action");
                toast(`User updated: ${shouldBePro ? "PRO Active" : "Free Tier"}`);
            } catch (error) {
                toast(`Error updating user: ${error.message}`);
                reportFirestoreError(error, "action");
            }
        },
        shouldBePro ? "Grant PRO" : "Revoke PRO"
    );
};

window.adminPurgeTrash = () => {
    if (isPurgingTrash) return;
    const trashCount = photosData.filter(photo => photo.isDeleted === true).length;
    if (!trashCount) {
        toast("Cloud trash is already empty");
        return;
    }
    confirmAction(
        "Empty Cloud Trash?",
        `Permanently delete all ${trashCount} photos marked as trash in user_photos. This cannot be undone.`,
        async () => {
            isPurgingTrash = true;
            renderCurrentTab();
            try {
                const trashSnapshot = await getDocs(query(collection(db, "user_photos"), where("isDeleted", "==", true)));
                let deletedCount = 0;
                const documents = trashSnapshot.docs;
                for (let start = 0; start < documents.length; start += 450) {
                    const batch = writeBatch(db);
                    const chunk = documents.slice(start, start + 450);
                    chunk.forEach(snapshot => batch.delete(snapshot.ref));
                    await batch.commit();
                    deletedCount += chunk.length;
                }
                clearFirestoreError("action");
                toast(deletedCount ? `Permanently deleted ${deletedCount} trash photos` : "Cloud trash is already empty");
            } catch (error) {
                toast(`Trash purge failed: ${error.message}`);
                reportFirestoreError(error, "action");
            } finally {
                isPurgingTrash = false;
                renderCurrentTab();
            }
        },
        "Empty Trash"
    );
};

window.adminToggleConfig = async (key, val) => {
    try {
        const configRef = doc(db, "app_config", "global");
        await setDoc(configRef, { [key]: val }, { merge: true });
        clearFirestoreError("action");
        toast(`Global setting updated: ${key} = ${val}`);
    } catch (e) {
        toast("Config update failed: " + e.message);
        reportFirestoreError(e, "action");
    }
};

window.adminDeletePhoto = (documentPath) => {
    confirmAction("Delete Photo?", "This photo will be permanently deleted from cloud database.", async () => {
        try {
            await deleteDoc(doc(db, documentPath));
            clearFirestoreError("action");
            toast("Photo Permanently Deleted");
        } catch (e) {
            toast("Error: " + e.message);
            reportFirestoreError(e, "action");
        }
    });
};

window.adminWipeUser = (uid) => {
    confirmAction(`Wipe User Data?`, `All photos and albums belonging to ${uid} will be permanently removed.`, async () => {
        try {
            const q = query(collection(db, "user_photos"), where("uid", "==", uid));
            const snap = await getDocs(q);
            const paths = new Set();
            snap.forEach(d => paths.add(d.ref.path));
            const nestedSnap = await getDocs(query(collectionGroup(db, "photos"), where("uid", "==", uid)));
            nestedSnap.forEach(d => paths.add(d.ref.path));
            getAllPhotos().filter(photo => photo.uid === uid).forEach(photo => {
                if (photo.path) paths.add(photo.path);
            });
            const pathList = Array.from(paths);
            for (let start = 0; start < pathList.length; start += 500) {
                const batch = writeBatch(db);
                pathList.slice(start, start + 500).forEach(path => batch.delete(doc(db, path)));
                await batch.commit();
            }
            clearFirestoreError("action");
            toast("User photos purged successfully");
        } catch (e) {
            toast("Purge failed: " + e.message);
            reportFirestoreError(e, "action");
        }
    });
};

window.adminDeleteAlbum = (albumId) => {
    confirmAction("Delete Album?", "Album will be deleted. Photos inside will remain safe.", async () => {
        try {
            await deleteDoc(doc(db, "user_albums", albumId));
            clearFirestoreError("action");
            toast("Album deleted");
        } catch (e) {
            toast("Failed to delete album: " + e.message);
            reportFirestoreError(e, "action");
        }
    });
};

// --------------------------------------------------------------------------
// 5. NAVIGATION SETUP
// --------------------------------------------------------------------------
function setupNav() {
    const pageTitles = {
        dashboard: "Live Dashboard & Analytics",
        photos: "All Cloud Photos",
        users: "User Management",
        albums: "Albums & Folders",
        settings: "System Settings"
    };
    const navigateTo = tab => {
        if (!pageTitles[tab]) return;
        document.querySelectorAll(".menu-item, .dock-item").forEach(item => {
            item.classList.toggle("active", item.dataset.tab === tab);
        });
        currentTab = tab;
        document.getElementById("pageHeading").textContent = pageTitles[tab];
        renderCurrentTab();
        document.getElementById("sidebar")?.classList.remove("open");
    };

    document.querySelectorAll(".menu-item, .dock-item").forEach(item => {
        item.addEventListener("click", () => {
            navigateTo(item.dataset.tab);
        });
    });

    document.getElementById("mobileToggleBtn")?.addEventListener("click", () => {
        document.getElementById("sidebar")?.classList.toggle("open");
    });

    document.getElementById("btnRefreshData")?.addEventListener("click", () => {
        toast("Refreshing real-time data");
        renderCurrentTab();
    });

    document.getElementById("btnLogoutAdmin")?.addEventListener("click", async () => {
        try {
            await signOut(auth);
        } catch (error) {
            toast(`Unable to sign out: ${error.message}`);
        }
        location.reload();
    });
}

function setupLightbox() {
    const lightbox = document.getElementById("photoLightbox");
    const image = document.getElementById("lightboxImage");
    const close = () => {
        lightbox.hidden = true;
        lightboxPhotoPath = null;
        image.src = "";
        lightboxZoom = 1;
    };
    document.getElementById("lightboxClose")?.addEventListener("click", close);
    lightbox?.addEventListener("click", event => {
        if (event.target === lightbox) close();
    });
    document.getElementById("lightboxZoomIn")?.addEventListener("click", () => {
        lightboxZoom = Math.min(4, lightboxZoom + 0.25);
        image.style.transform = `scale(${lightboxZoom})`;
    });
    document.getElementById("lightboxZoomOut")?.addEventListener("click", () => {
        lightboxZoom = Math.max(1, lightboxZoom - 0.25);
        image.style.transform = `scale(${lightboxZoom})`;
    });
    document.getElementById("lightboxDelete")?.addEventListener("click", () => {
        const path = lightboxPhotoPath;
        close();
        if (path) window.adminDeletePhoto(path);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !lightbox.hidden) close();
    });
}

watchAdminAuthState();
processGoogleRedirectResult();
initAuth();
setupNav();
setupLightbox();
