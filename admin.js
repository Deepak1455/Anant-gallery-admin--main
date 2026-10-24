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
    where,
    serverTimestamp
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
let appUpdateData = {};
let appUpdateLoaded = false;
let appUpdateFormDirty = false;
let isPublishingAppUpdate = false;
const botNodes = Array.from({ length: 15 }, (_, index) => ({
    id: index + 1,
    status: "unknown",
    latency: null,
    error: ""
}));
let isPingingAllNodes = false;
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
    if (currentTab === "app_updates" && appUpdateFormDirty) return;
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

    onSnapshot(doc(db, "app_config", "app_update"), snap => {
        clearFirestoreError("app-update");
        appUpdateData = snap.exists() ? snap.data() : {};
        appUpdateLoaded = true;
        if (currentTab === "app_updates" && !appUpdateFormDirty) renderCurrentTab();
    }, error => reportFirestoreError(error, "app-update"));
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
    else if (currentTab === "bots") renderBots(container);
    else if (currentTab === "app_updates") renderAppUpdates(container);

    const pingAllButton = document.getElementById("btnPingAllNodes");
    if (pingAllButton) pingAllButton.hidden = currentTab !== "bots";

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
                            const email = typeof profile.email === "string" ? profile.email.trim() : "";
                            const hasEmail = email && email.toLowerCase() !== "email unavailable";
                            const searchValue = `${hasEmail ? email : "Guest Anonymous"} ${u.uid}`.toLowerCase();
                            return `
                                <tr data-user-search="${escapeHtml(searchValue)}">
                                    <td>
                                        <div class="user-identity">
                                            <strong>${hasEmail ? copyControl(email, "email") : '<span class="tag hidden" style="background:#374151; color:#9ca3af;"><i class="fa-solid fa-user-secret"></i> Guest / Anonymous</span>'}</strong>
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
                    const email = typeof profile.email === "string" ? profile.email.trim() : "";
                    const hasEmail = email && email.toLowerCase() !== "email unavailable";
                    const searchValue = `${hasEmail ? email : "Guest Anonymous"} ${u.uid}`.toLowerCase();
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
                            <div class="data-field"><span>Email</span>${hasEmail ? copyControl(email, "email") : '<span class="tag hidden" style="background:#374151; color:#9ca3af;"><i class="fa-solid fa-user-secret"></i> Guest / Anonymous</span>'}</div>
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

// TAB 6: TELEGRAM BOT NODE HEALTH
function renderBots(container) {
    const onlineCount = botNodes.filter(node => node.status === "online").length;
    container.innerHTML = `
        <section class="bot-monitor">
            <div class="bot-monitor-heading">
                <div>
                    <p class="module-eyebrow">Infrastructure health</p>
                    <h3>Telegram Bot CDN</h3>
                    <p class="module-description">Run a live connectivity check against each configured bot node.</p>
                </div>
                <div class="bot-online-count" role="status" aria-live="polite">
                    <span>${onlineCount} / 15</span> Online
                </div>
            </div>
            <div class="bot-node-grid">
                ${botNodes.map(node => `
                    <article class="bot-node-card">
                        <div class="bot-node-heading">
                            <div>
                                <h4>CDN-Node-${node.id}</h4>
                                <span class="bot-token-mask" aria-label="Bot token masked and configured server-side">Token <span>••••••••••••</span> (server-side)</span>
                            </div>
                            <span class="bot-status ${node.status}" aria-label="${node.status}" title="${node.status}">
                                <span class="bot-status-dot"></span>
                                ${node.status === "testing" ? "Testing" : node.status === "online" ? "ACTIVE" : node.status === "offline" ? "Offline" : "Not checked"}
                            </span>
                        </div>
                        <div class="bot-node-meta">
                            <span><i class="fa-solid fa-gauge-high"></i> Latency</span>
                            <strong>${node.latency === null ? "--" : `${node.latency}ms`}</strong>
                        </div>
                        ${node.error ? `<p class="bot-node-error" role="status">${escapeHtml(node.error)}</p>` : ""}
                        <button class="secondary-action bot-test-button" type="button" data-node-id="${node.id}" ${node.status === "testing" ? "disabled" : ""}>
                            <i class="fa-solid fa-vial"></i> ${node.status === "testing" ? "Testing..." : "Test node"}
                        </button>
                    </article>
                `).join("")}
            </div>
        </section>
    `;

    container.querySelectorAll(".bot-test-button").forEach(button => {
        button.addEventListener("click", () => window.testSingleBot(Number(button.dataset.nodeId)));
    });
    const pingAllButton = document.getElementById("btnPingAllNodes");
    if (pingAllButton) pingAllButton.disabled = isPingingAllNodes;
}

window.testSingleBot = async botId => {
    const node = botNodes.find(item => item.id === botId);
    if (!node) throw new Error(`Unknown bot node: ${botId}`);
    if (node.status === "testing") return node;

    node.status = "testing";
    node.error = "";
    renderCurrentTab();
    const startedAt = performance.now();

    try {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 10000);
        let response;
        try {
            response = await fetch(`https://anant-gallery.vercel.app/api/upload?checkNode=${encodeURIComponent(botId)}`, {
                method: "GET",
                mode: "cors",
                cache: "no-store",
                signal: controller.signal
            });
        } finally {
            window.clearTimeout(timeoutId);
        }

        node.latency = Math.max(0, Math.round(performance.now() - startedAt));
        if ([500, 502, 503].includes(response.status)) {
            throw new Error(`Health check returned ${response.status}`);
        }
        node.status = "online";
        node.error = "";
        return node;
    } catch (error) {
        node.status = "offline";
        node.error = error.name === "AbortError" ? "Health check timed out" : error.message || "Health check failed";
        throw error;
    } finally {
        renderCurrentTab();
    }
};

async function testAllBotNodes() {
    if (isPingingAllNodes) return;
    isPingingAllNodes = true;
    renderCurrentTab();
    try {
        const results = await Promise.allSettled(botNodes.map(node => window.testSingleBot(node.id)));
        const onlineCount = botNodes.filter(node => node.status === "online").length;
        const failedCount = results.filter(result => result.status === "rejected").length;
        toast(`${onlineCount} / 15 nodes online${failedCount ? `; ${failedCount} checks failed` : ""}`);
    } finally {
        isPingingAllNodes = false;
        renderCurrentTab();
    }
}

// TAB 7: APP UPDATE AND ANNOUNCEMENT PUBLISHER
function renderAppUpdates(container) {
    const updateError = firestoreErrors["app-update"];
    const data = appUpdateData;
    container.innerHTML = `
        <section class="app-update-card">
            <div class="app-update-heading">
                <div class="app-update-icon"><i class="fa-solid fa-bullhorn"></i></div>
                <div>
                    <p class="module-eyebrow">Remote configuration</p>
                    <h3>Featured Update & Announcement</h3>
                    <p class="module-description">Publish update requirements and an in-app message to all users.</p>
                </div>
            </div>
            ${updateError ? `<div class="firestore-error" role="alert"><strong>${escapeHtml(updateError.title)}</strong><p>${escapeHtml(updateError.details)}</p></div>` : ""}
            ${!appUpdateLoaded ? '<p class="update-sync-note" role="status"><i class="fa-solid fa-spinner fa-spin"></i> Connecting to live update settings...</p>' : ""}
            <form id="appUpdateForm" class="app-update-form">
                <label class="update-field">
                    <span>Latest Version Code</span>
                    <input id="updateLatestVersionCode" name="latestVersionCode" type="number" min="1" step="1" required value="${escapeHtml(data.latestVersionCode ?? "")}" placeholder="5">
                </label>
                <label class="update-field">
                    <span>Version Name</span>
                    <input id="updateVersionName" name="versionName" type="text" required maxlength="40" value="${escapeHtml(data.versionName ?? "")}" placeholder="1.1.3">
                </label>
                <label class="update-field">
                    <span>Minimum Supported Version</span>
                    <input id="updateMinimumSupportedVersion" name="minimumSupportedVersion" type="number" min="0" step="1" required value="${escapeHtml(data.minimumSupportedVersion ?? "")}" placeholder="4">
                </label>
                <label class="update-field update-toggle-field" for="updateForceUpdate">
                    <span>
                        <strong>Force Update</strong>
                        <small>Block older versions until users update.</small>
                    </span>
                    <input id="updateForceUpdate" name="forceUpdate" type="checkbox" ${data.forceUpdate === true ? "checked" : ""}>
                </label>
                <label class="update-field update-field-wide">
                    <span>Update Dialog Title</span>
                    <input id="updateDialogTitle" name="dialogTitle" type="text" required maxlength="120" value="${escapeHtml(data.dialogTitle ?? "")}" placeholder="Google Sign-In &amp; Performance Fix">
                </label>
                <label class="update-field update-field-wide">
                    <span>What's New / Release Notes</span>
                    <textarea id="updateReleaseNotes" name="releaseNotes" rows="5" maxlength="4000" placeholder="Add release notes shown in the update dialog.">${escapeHtml(data.releaseNotes ?? "")}</textarea>
                </label>
                <label class="update-field update-field-wide">
                    <span>In-App Announcement Banner</span>
                    <input id="updateAnnouncementBanner" name="announcementBanner" type="text" maxlength="240" value="${escapeHtml(data.announcementBanner ?? "")}" placeholder="Get Anant PRO 50% Off this week!">
                </label>
                <div class="update-form-footer update-field-wide">
                    <p class="update-sync-note"><i class="fa-solid fa-tower-broadcast"></i> Live document: <code>app_config/app_update</code></p>
                    <button class="primary-action publish-update-button" type="submit" ${isPublishingAppUpdate ? "disabled" : ""}>
                        <i class="fa-solid fa-cloud-arrow-up"></i> ${isPublishingAppUpdate ? "Publishing..." : "Publish Update to All Users"}
                    </button>
                </div>
            </form>
        </section>
    `;

    const form = document.getElementById("appUpdateForm");
    form?.addEventListener("input", () => { appUpdateFormDirty = true; });
    form?.addEventListener("change", () => { appUpdateFormDirty = true; });
    form?.addEventListener("submit", publishAppUpdate);
}

async function publishAppUpdate(event) {
    event.preventDefault();
    if (isPublishingAppUpdate) return;

    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const formData = new FormData(form);
    const latestVersionCode = Number(formData.get("latestVersionCode"));
    const minimumSupportedVersion = Number(formData.get("minimumSupportedVersion"));
    if (!Number.isInteger(latestVersionCode) || latestVersionCode < 1 ||
        !Number.isInteger(minimumSupportedVersion) || minimumSupportedVersion < 0 ||
        minimumSupportedVersion > latestVersionCode) {
        toast("Version codes must be whole numbers, and the minimum cannot exceed the latest version");
        return;
    }

    const update = {
        latestVersionCode,
        versionName: String(formData.get("versionName") || "").trim(),
        minimumSupportedVersion,
        forceUpdate: formData.get("forceUpdate") === "on",
        dialogTitle: String(formData.get("dialogTitle") || "").trim(),
        releaseNotes: String(formData.get("releaseNotes") || "").trim(),
        announcementBanner: String(formData.get("announcementBanner") || "").trim(),
        updatedAt: serverTimestamp()
    };

    isPublishingAppUpdate = true;
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...';
    }
    let published = false;
    try {
        await setDoc(doc(db, "app_config", "app_update"), update, { merge: true });
        appUpdateData = { ...update };
        delete appUpdateData.updatedAt;
        appUpdateFormDirty = false;
        clearFirestoreError("app-update");
        clearFirestoreError("action");
        published = true;
        toast("App update published to all users");
    } catch (error) {
        toast(`Unable to publish app update: ${error.message}`);
    } finally {
        isPublishingAppUpdate = false;
        if (published) {
            renderCurrentTab();
        } else if (submitButton?.isConnected) {
            submitButton.disabled = false;
            submitButton.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Publish Update to All Users';
        }
    }
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
        settings: "System Settings",
        bots: "Bot CDN (15 Nodes)",
        app_updates: "App Update Manager"
    };
    const navigateTo = tab => {
        if (!pageTitles[tab]) return;
        if (currentTab === "app_updates" && tab !== "app_updates") appUpdateFormDirty = false;
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
    document.getElementById("btnPingAllNodes")?.addEventListener("click", testAllBotNodes);

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
