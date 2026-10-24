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
            showAdminWorkspace("Admin Access Granted");
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
function confirmAction(title, desc, onConfirm) {
    const modal = document.getElementById("adminModal");
    if (!modal) {
        if (confirm(title + "\n" + desc)) {
            if (onConfirm) onConfirm();
        }
        return;
    }
    document.getElementById("modalTitle").innerText = title;
    document.getElementById("modalDesc").innerText = desc;
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
                showAdminWorkspace("Admin Access Granted");
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
            showAdminWorkspace("Admin Access Granted");
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

    if (currentTab === "dashboard") renderDashboard(container);
    else if (currentTab === "photos") renderPhotos(container);
    else if (currentTab === "users") renderUsers(container);
    else if (currentTab === "albums") renderAlbums(container);
    else if (currentTab === "settings") renderSettings(container);
}

// TAB 1: DASHBOARD
function renderDashboard(container) {
    const allPhotos = getAllPhotos();
    const totalPhotos = allPhotos.length;
    const inTrash = allPhotos.filter(p => p.isDeleted).length;
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

        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-clock-rotate-left" style="color:var(--accent);"></i> Recent 8 Cloud Uploads</h3>
            </div>
            <div style="overflow-x:auto;">
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
                                <td><img src="${escapeHtml(getPhotoImage(p))}" class="table-img" onerror="this.src='https://via.placeholder.com/50'"></td>
                                <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(p.id)}</td>
                                <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(p.uid || 'Anonymous')}</td>
                                <td>
                                    <span class="tag ${p.isDeleted ? 'trash' : (p.isHidden ? 'hidden' : 'active')}">
                                        ${p.isDeleted ? 'Trash' : (p.isHidden ? 'Private' : 'Active')}
                                    </span>
                                </td>
                                <td>
                                    <button class="action-btn del" onclick="window.adminDeletePhoto(${inlineArg(p.path || `user_photos/${p.id}`)})"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// TAB 2: PHOTOS DIRECTORY
function renderPhotos(container) {
    const allPhotos = getAllPhotos();
    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-images" style="color:var(--accent);"></i> All Cloud Photos (${allPhotos.length})</h3>
                <div class="search-box">
                    <input type="text" id="photoFilter" placeholder="Search by Doc ID or UID...">
                </div>
            </div>
            <div style="overflow-x:auto;">
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
                        ${renderPhotoList(allPhotos)}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    document.getElementById("photoFilter")?.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase().trim();
        const filtered = getAllPhotos().filter(p => p.id.toLowerCase().includes(q) || (p.uid && p.uid.toLowerCase().includes(q)));
        document.getElementById("photoRows").innerHTML = renderPhotoList(filtered);
    });
}

function renderPhotoList(list) {
    if (list.length === 0) return `<tr><td colspan="5" style="text-align:center; padding:30px;">No photos found.</td></tr>`;
    return list.map(p => `
        <tr>
            <td><img src="${escapeHtml(getPhotoImage(p))}" class="table-img" onerror="this.src='https://via.placeholder.com/50'"></td>
            <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(p.id)}</td>
            <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(p.uid || 'Anonymous')}</td>
            <td>
                <span class="tag ${p.isDeleted ? 'trash' : (p.isHidden ? 'hidden' : 'active')}">
                    ${p.isDeleted ? 'Trash' : (p.isHidden ? 'Private' : 'Active')}
                </span>
            </td>
            <td>
                <button class="action-btn" onclick="window.open(${inlineArg(getPhotoImage(p))}, '_blank', 'noopener')"><i class="fa-solid fa-eye"></i></button>
                <button class="action-btn del" onclick="window.adminDeletePhoto(${inlineArg(p.path || `user_photos/${p.id}`)})"><i class="fa-solid fa-trash"></i></button>
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
            </div>
            <div style="overflow-x:auto;">
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
                            const email = profile.email || u.uid;
                            return `
                                <tr>
                                    <td style="font-family:monospace; font-weight:700;">${escapeHtml(email)}</td>
                                    <td><span class="tag active">${u.count} Photos</span></td>
                                    <td>${formatSize(u.bytes)}</td>
                                    <td>
                                        <span class="tag ${isPro ? 'active' : 'hidden'}" style="${isPro ? 'background:#8b5cf6;' : ''}">
                                            ${isPro ? 'Anant PRO' : 'Free Tier'}
                                        </span>
                                    </td>
                                    <td>
                                        <button class="action-btn" style="background:${isPro ? '#ef4444' : '#10b981'}; width:auto; padding:6px 12px; font-size:0.75rem;" onclick="window.adminTogglePro(${inlineArg(u.uid)}, ${!isPro})">
                                            ${isPro ? 'Revoke PRO' : 'Grant Anant PRO'}
                                        </button>
                                        <button class="action-btn del" onclick="window.adminWipeUser(${inlineArg(u.uid)})" title="Wipe User Data">
                                            <i class="fa-solid fa-trash-can"></i>
                                        </button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// TAB 4: ALBUMS
function renderAlbums(container) {
    container.innerHTML = `
        <div class="table-board">
            <div class="t-header">
                <h3><i class="fa-solid fa-folder-tree" style="color:var(--accent);"></i> All Cloud Albums (${albumsData.length})</h3>
            </div>
            <div style="overflow-x:auto;">
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
                                <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(a.id)}</td>
                                <td style="font-family:monospace; font-size:0.75rem;">${escapeHtml(a.uid)}</td>
                                <td>
                                    <button class="action-btn del" onclick="window.adminDeleteAlbum(${inlineArg(a.id)})"><i class="fa-solid fa-trash"></i></button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
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
window.adminTogglePro = async (uid, shouldBePro) => {
    try {
        await setDoc(doc(db, "users", uid), { isPro: shouldBePro }, { merge: true });
        clearFirestoreError("action");
        toast(`User updated: ${shouldBePro ? "PRO Active" : "Free Tier"}`);
    } catch (error) {
        toast(`Error updating user: ${error.message}`);
        reportFirestoreError(error, "action");
    }
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
    document.querySelectorAll(".menu-item").forEach(item => {
        item.addEventListener("click", () => {
            document.querySelectorAll(".menu-item").forEach(n => n.classList.remove("active"));
            item.classList.add("active");
            currentTab = item.dataset.tab;
            renderCurrentTab();
            document.getElementById("sidebar")?.classList.remove("open");
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

watchAdminAuthState();
processGoogleRedirectResult();
initAuth();
setupNav();
