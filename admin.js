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
let appConfigData = { ads_enabled: true };
let globalThemeData = {};
let selectedGlobalThemeId = "DEFAULT_LIGHT";
let globalThemeSelectionDirty = false;
let globalThemeStudioDirty = false;
let globalThemeWallpaperFile = null;
let globalThemeWallpaperPreviewUrl = "";
let globalThemeStudioDraft = {
    theme_bg_url: "",
    accent_color: "#FFD700",
    text_color: "#FFF3C4",
    card_opacity: 75,
    enable_particles: false
};
let modularThemeData = {};
let modularThemeDirty = false;
let modularThemeDraft = {
    is_modular_theme_active: false,
    root_bg_url: "",
    header_bg_url: "",
    bottom_nav_bg_url: "",
    album_card_bg_url: "",
    text_card_bg_url: "",
    metric_pill_bg_url: "",
    accent_color: "#FFD700",
    title_color: "#FFF3C4",
    metric_color: "#FFFFFF"
};
const modularThemeUrlFields = {
    txtModularRootBg: { key: "root_bg_url", preview: "previewModularRootBg" },
    txtModularHeaderBg: { key: "header_bg_url", preview: "previewModularHeaderBg" },
    txtModularBottomNavBg: { key: "bottom_nav_bg_url", preview: "previewModularBottomNavBg" },
    txtModularAlbumCardBg: { key: "album_card_bg_url", preview: "previewModularAlbumCardBg" },
    txtModularTextCardBg: { key: "text_card_bg_url", preview: "previewModularTextCardBg" },
    txtModularPillBg: { key: "metric_pill_bg_url", preview: "previewModularPillBg" }
};
let appUpdateData = {};
let appUpdateLoaded = false;
const dirtyAppUpdateCards = new Set();
const savingAppUpdateCards = new Set();
const globalThemeAccents = {
    DIWALI_FESTIVE: "#D4AF37",
    OLED_DARK: "#000000",
    CYBER_VIOLET: "#8B5CF6",
    DEFAULT_LIGHT: "#6750A4"
};
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
let pendingProGrantUid = null;

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
    if (currentTab === "app_updates" && dirtyAppUpdateCards.size > 0) return;
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

function formatProExpiryDate(value) {
    if (!value) return "Unknown date";
    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    }).format(date);
}

function renderUserMembership(profile) {
    if (profile.isPro !== true) return '<span class="tag free">Free Tier</span>';

    const expiresAt = !profile.proExpiresAt
        ? new Date(Number.NaN)
        : typeof profile.proExpiresAt.toDate === "function"
            ? profile.proExpiresAt.toDate()
            : new Date(profile.proExpiresAt);
    const daysLeft = Number.isNaN(expiresAt.getTime())
        ? 0
        : Math.max(0, Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24)));
    const planName = escapeHtml(profile.proPlanName || "Anant PRO");

    return `
        <span class="tag active" style="background:#8b5cf6;">${planName}</span>
        <span class="tag" style="background:#065f46; color:#34d399; margin-left:6px;">${daysLeft} Days Left</span>
        <span class="pro-expiry-date" style="display:block; margin-top:6px;">Expiry: ${escapeHtml(formatProExpiryDate(profile.proExpiresAt))}</span>
    `;
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
            const config = snap.data();
            appConfigData = { ...config, show_pro_card: config.show_pro_card !== false };
        } else {
            appConfigData = { ads_enabled: true, show_pro_card: true };
        }
        if (currentTab === "settings" || currentTab === "dashboard") {
            renderCurrentTab();
        } else if (currentTab === "app_updates") {
            syncAppUpdateForm();
        }
    }, error => reportFirestoreError(error, "config"));

    onSnapshot(doc(db, "app_config", "app_update"), snap => {
        clearFirestoreError("app-update");
        appUpdateData = snap.exists() ? snap.data() : {};
        appUpdateLoaded = true;
        if (currentTab === "app_updates") syncAppUpdateForm();
    }, error => reportFirestoreError(error, "app-update"));

    onSnapshot(doc(db, "app_config", "theme"), snap => {
        clearFirestoreError("theme");
        globalThemeData = snap.exists() ? snap.data() : {};
        const activeTheme = globalThemeData.active_theme;
        if (typeof activeTheme === "string" && Object.hasOwn(globalThemeAccents, activeTheme)) {
            if (!globalThemeSelectionDirty || activeTheme === selectedGlobalThemeId) {
                selectedGlobalThemeId = activeTheme;
                globalThemeSelectionDirty = false;
            }
        } else if (!globalThemeSelectionDirty) {
            selectedGlobalThemeId = "DEFAULT_LIGHT";
        }
        if (!globalThemeStudioDirty) {
            globalThemeStudioDraft = {
                theme_bg_url: typeof globalThemeData.theme_bg_url === "string" ? globalThemeData.theme_bg_url : "",
                accent_color: isHexColor(globalThemeData.accent_color) ? globalThemeData.accent_color : "#FFD700",
                text_color: isHexColor(globalThemeData.text_color) ? globalThemeData.text_color : "#FFF3C4",
                card_opacity: Number.isFinite(Number(globalThemeData.card_opacity))
                    ? Math.min(100, Math.max(0, Number(globalThemeData.card_opacity)))
                    : 75,
                enable_particles: globalThemeData.enable_particles === true
            };
        }
        if (currentTab === "settings") {
            const themeSelector = document.getElementById("selectGlobalTheme");
            if (themeSelector && !globalThemeSelectionDirty) themeSelector.value = selectedGlobalThemeId;
            if (!globalThemeStudioDirty) syncThemeStudioControls();
        }
    }, error => reportFirestoreError(error, "theme"));

    onSnapshot(doc(db, "app_config", "theme_engine"), snap => {
        clearFirestoreError("theme-engine");
        modularThemeData = snap.exists() ? snap.data() : {};
        if (!modularThemeDirty) {
            modularThemeDraft = {
                is_modular_theme_active: modularThemeData.is_modular_theme_active === true,
                root_bg_url: typeof modularThemeData.root_bg_url === "string" ? modularThemeData.root_bg_url : "",
                header_bg_url: typeof modularThemeData.header_bg_url === "string" ? modularThemeData.header_bg_url : "",
                bottom_nav_bg_url: typeof modularThemeData.bottom_nav_bg_url === "string" ? modularThemeData.bottom_nav_bg_url : "",
                album_card_bg_url: typeof modularThemeData.album_card_bg_url === "string" ? modularThemeData.album_card_bg_url : "",
                text_card_bg_url: typeof modularThemeData.text_card_bg_url === "string" ? modularThemeData.text_card_bg_url : "",
                metric_pill_bg_url: typeof modularThemeData.metric_pill_bg_url === "string" ? modularThemeData.metric_pill_bg_url : "",
                accent_color: typeof modularThemeData.accent_color === "string" ? modularThemeData.accent_color : "#FFD700",
                title_color: typeof modularThemeData.title_color === "string" ? modularThemeData.title_color : "#FFF3C4",
                metric_color: typeof modularThemeData.metric_color === "string" ? modularThemeData.metric_color : "#FFFFFF"
            };
        }
        if (currentTab === "settings" && !modularThemeDirty) syncModularThemeControls();
    }, error => reportFirestoreError(error, "theme-engine"));
}

function isHexColor(value) {
    return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function normalizeThemeWallpaperUrl(value) {
    const url = String(value ?? "").trim();
    return url.startsWith("/api/") ? `https://anant-gallery.vercel.app${url}` : url;
}

function syncThemeStudioControls() {
    const urlInput = document.getElementById("txtThemeBgUrl");
    const accentInput = document.getElementById("txtThemeAccent");
    const textColorInput = document.getElementById("txtThemeTextColor");
    const opacityInput = document.getElementById("rngThemeCardOpacity");
    const particlesInput = document.getElementById("chkThemeParticles");
    const fileName = document.getElementById("themeBgFileName");
    if (!urlInput || !accentInput || !textColorInput || !opacityInput || !particlesInput) return;

    urlInput.value = globalThemeStudioDraft.theme_bg_url;
    accentInput.value = globalThemeStudioDraft.accent_color;
    textColorInput.value = globalThemeStudioDraft.text_color;
    opacityInput.value = String(globalThemeStudioDraft.card_opacity);
    particlesInput.checked = globalThemeStudioDraft.enable_particles;
    if (fileName) fileName.textContent = globalThemeWallpaperFile?.name || "No image selected";
    updateThemeStudioPreview();
}

function syncModularThemeControls() {
    const toggle = document.getElementById("switchModularTheme");
    const accentInput = document.getElementById("txtModAccent");
    const titleInput = document.getElementById("txtModTitle");
    const metricInput = document.getElementById("txtModMetric");
    if (!toggle || !accentInput || !titleInput || !metricInput) return;

    toggle.checked = modularThemeDraft.is_modular_theme_active;
    accentInput.value = modularThemeDraft.accent_color;
    titleInput.value = modularThemeDraft.title_color;
    metricInput.value = modularThemeDraft.metric_color;
    Object.entries(modularThemeUrlFields).forEach(([inputId, field]) => {
        const input = document.getElementById(inputId);
        const preview = document.getElementById(field.preview);
        if (!input || !preview) return;
        const url = normalizeThemeWallpaperUrl(modularThemeDraft[field.key]);
        input.value = url;
        preview.src = url;
        preview.hidden = !url;
        preview.classList.toggle("has-preview", Boolean(url));
    });
}

function updateThemeStudioPreview() {
    const preview = document.getElementById("themeBgPreview");
    const image = document.getElementById("themeBgPreviewImage");
    const emptyState = document.getElementById("themeBgPreviewEmpty");
    const previewCard = document.getElementById("themePreviewCard");
    const opacityOutput = document.getElementById("themeCardOpacityValue");
    const accent = document.getElementById("txtThemeAccent")?.value;
    const textColor = document.getElementById("txtThemeTextColor")?.value;
    const opacity = document.getElementById("rngThemeCardOpacity")?.value;
    const url = globalThemeWallpaperPreviewUrl ||
        normalizeThemeWallpaperUrl(document.getElementById("txtThemeBgUrl")?.value) ||
        normalizeThemeWallpaperUrl(globalThemeStudioDraft.theme_bg_url);

    if (!preview || !image || !emptyState || !previewCard) return;
    previewCard.style.setProperty("--theme-preview-accent", isHexColor(accent) ? accent : "#FFD700");
    previewCard.style.setProperty("--theme-preview-text", isHexColor(textColor) ? textColor : "#FFF3C4");
    previewCard.style.setProperty("--theme-preview-opacity", String((Number(opacity) || 0) / 100));
    if (opacityOutput) opacityOutput.value = `${opacity || 0}%`;

    if (url) {
        image.src = url;
        image.hidden = false;
        emptyState.hidden = true;
        preview.classList.add("has-wallpaper");
    } else {
        image.removeAttribute("src");
        image.hidden = true;
        emptyState.hidden = false;
        preview.classList.remove("has-wallpaper");
    }
}

async function uploadThemeWallpaper(file) {
    const formData = new FormData();
    formData.append("file", file, file.name);
    const response = await fetch("https://anant-gallery.vercel.app/api/upload", {
        method: "POST",
        mode: "cors",
        body: formData
    });
    let result;
    try {
        result = await response.json();
    } catch (error) {
        throw new Error(`Wallpaper upload returned an invalid response: ${error.message}`);
    }
    if (!response.ok) {
        throw new Error(result?.error || `Wallpaper upload failed with status ${response.status}`);
    }

    const imageUrl = result?.url || result?.imageUrl || result?.image_url ||
        result?.photoUrl || result?.cdnUrl || result?.fileUrl ||
        result?.data?.url || result?.data?.imageUrl;
    if (typeof imageUrl !== "string" || !imageUrl.trim()) {
        throw new Error("Wallpaper upload response did not include a CDN image URL");
    }
    return imageUrl.trim();
}

// --------------------------------------------------------------------------
// 3. TAB RENDERERS
// --------------------------------------------------------------------------
function renderCurrentTab() {
    const container = document.getElementById("contentContainer");
    if (!container) return;
    container.classList.toggle("app-update-content", currentTab === "app_updates");

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
                                        <div class="membership-details">${renderUserMembership(profile)}</div>
                                    </td>
                                    <td>
                                        <button class="secondary-action" type="button" onclick="window.adminTogglePro(${inlineArg(u.uid)}, ${!isPro})">
                                            ${isPro ? 'Revoke PRO' : 'Grant PRO'}
                                        </button>
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
                                <div class="membership-details">${renderUserMembership(profile)}</div>
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
                <div id="globalThemeConfigSlot"></div>

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
                    <div id="proCardConfigSlot" style="margin-top:16px;"></div>
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

    const globalThemeTemplate = document.getElementById("globalThemeConfigTemplate");
    const globalThemeSlot = document.getElementById("globalThemeConfigSlot");
    if (!(globalThemeTemplate instanceof HTMLTemplateElement) || !globalThemeSlot) {
        throw new Error("Global theme configuration template is missing");
    }
    globalThemeSlot.append(globalThemeTemplate.content.cloneNode(true));
    const themeSelector = document.getElementById("selectGlobalTheme");
    const applyThemeButton = document.getElementById("btnApplyGlobalTheme");
    themeSelector.value = selectedGlobalThemeId;
    syncThemeStudioControls();
    syncModularThemeControls();
    themeSelector.addEventListener("change", () => {
        selectedGlobalThemeId = themeSelector.value;
        globalThemeSelectionDirty = true;
    });
    applyThemeButton.addEventListener("click", async () => {
        const selectedThemeId = themeSelector.value;
        const themeAccentHex = globalThemeAccents[selectedThemeId];
        if (!themeAccentHex) {
            toast("Select a valid app theme");
            return;
        }

        applyThemeButton.disabled = true;
        try {
            await setDoc(doc(db, "app_config", "theme"), {
                active_theme: selectedThemeId,
                accent_color: themeAccentHex,
                theme_updated_at: new Date().toISOString()
            }, { merge: true });
            globalThemeData = { ...globalThemeData, active_theme: selectedThemeId, accent_color: themeAccentHex };
            selectedGlobalThemeId = selectedThemeId;
            globalThemeSelectionDirty = false;
            clearFirestoreError("action");
            toast(`Global Theme Updated: ${selectedThemeId}`);
        } catch (error) {
            toast(`Global theme update failed: ${error.message}`);
            reportFirestoreError(error, "action");
        } finally {
            applyThemeButton.disabled = false;
        }
    });

    const themeBgUrlInput = document.getElementById("txtThemeBgUrl");
    const themeBgFileInput = document.getElementById("fileThemeBg");
    const themeFileName = document.getElementById("themeBgFileName");
    const themeStudioStatus = document.getElementById("themeStudioStatus");
    const themeStudioInputs = [
        themeBgUrlInput,
        document.getElementById("txtThemeAccent"),
        document.getElementById("txtThemeTextColor"),
        document.getElementById("rngThemeCardOpacity"),
        document.getElementById("chkThemeParticles")
    ];
    themeStudioInputs.forEach(input => {
        input.addEventListener("input", () => {
            globalThemeStudioDirty = true;
            if (input === themeBgUrlInput) {
                globalThemeStudioDraft.theme_bg_url = themeBgUrlInput.value.trim();
                globalThemeWallpaperFile = null;
                if (globalThemeWallpaperPreviewUrl) URL.revokeObjectURL(globalThemeWallpaperPreviewUrl);
                globalThemeWallpaperPreviewUrl = "";
                if (themeFileName) themeFileName.textContent = "No image selected";
            } else if (input.id === "txtThemeAccent") {
                globalThemeStudioDraft.accent_color = input.value.trim();
            } else if (input.id === "txtThemeTextColor") {
                globalThemeStudioDraft.text_color = input.value.trim();
            } else if (input.id === "rngThemeCardOpacity") {
                globalThemeStudioDraft.card_opacity = Number(input.value);
            } else if (input.id === "chkThemeParticles") {
                globalThemeStudioDraft.enable_particles = input.checked;
            }
            updateThemeStudioPreview();
        });
    });
    themeBgFileInput.addEventListener("change", () => {
        const file = themeBgFileInput.files?.[0] || null;
        if (file && !file.type.startsWith("image/")) {
            themeBgFileInput.value = "";
            toast("Choose a valid image file");
            return;
        }
        globalThemeWallpaperFile = file;
        globalThemeStudioDirty = true;
        if (globalThemeWallpaperPreviewUrl) URL.revokeObjectURL(globalThemeWallpaperPreviewUrl);
        globalThemeWallpaperPreviewUrl = file ? URL.createObjectURL(file) : "";
        if (themeFileName) themeFileName.textContent = file?.name || "No image selected";
        updateThemeStudioPreview();
    });
    document.getElementById("btnSaveThemeStudio")?.addEventListener("click", async event => {
        const saveButton = event.currentTarget;
        const accentColorHex = document.getElementById("txtThemeAccent").value.trim();
        const textColorHex = document.getElementById("txtThemeTextColor").value.trim();
        const opacityValue = Number(document.getElementById("rngThemeCardOpacity").value);
        const isParticlesEnabled = document.getElementById("chkThemeParticles").checked;
        if (!isHexColor(accentColorHex) || !isHexColor(textColorHex)) {
            toast("Enter valid six-digit hex colors for accent and text");
            return;
        }

        let imageUrl = normalizeThemeWallpaperUrl(document.getElementById("txtThemeBgUrl").value);
        document.getElementById("txtThemeBgUrl").value = imageUrl;
        if (globalThemeWallpaperFile) {
            saveButton.disabled = true;
            if (themeStudioStatus) themeStudioStatus.textContent = "Uploading wallpaper";
            try {
                imageUrl = await uploadThemeWallpaper(globalThemeWallpaperFile);
            } catch (error) {
                toast(`Wallpaper upload failed: ${error.message}`);
                if (themeStudioStatus) themeStudioStatus.textContent = "Upload failed";
                saveButton.disabled = false;
                return;
            }
            document.getElementById("txtThemeBgUrl").value = imageUrl;
            globalThemeStudioDraft.theme_bg_url = imageUrl;
            globalThemeWallpaperFile = null;
            if (globalThemeWallpaperPreviewUrl) URL.revokeObjectURL(globalThemeWallpaperPreviewUrl);
            globalThemeWallpaperPreviewUrl = "";
            if (themeFileName) themeFileName.textContent = "No image selected";
            updateThemeStudioPreview();
        }
        if (imageUrl) {
            try {
                const parsedUrl = new URL(imageUrl);
                if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Unsupported protocol");
            } catch {
                toast("Enter a valid wallpaper image URL");
                saveButton.disabled = false;
                if (themeStudioStatus) themeStudioStatus.textContent = "Check wallpaper URL";
                return;
            }
        }

        saveButton.disabled = true;
        if (themeStudioStatus) themeStudioStatus.textContent = "Publishing theme";
        try {
            await setDoc(doc(db, "app_config", "theme"), {
                theme_bg_url: imageUrl,
                accent_color: accentColorHex,
                text_color: textColorHex,
                card_opacity: opacityValue,
                enable_particles: isParticlesEnabled,
                is_custom_theme_active: true,
                updated_at: new Date().toISOString()
            }, { merge: true });
            globalThemeStudioDraft = {
                theme_bg_url: imageUrl,
                accent_color: accentColorHex,
                text_color: textColorHex,
                card_opacity: opacityValue,
                enable_particles: isParticlesEnabled
            };
            globalThemeData = { ...globalThemeData, ...globalThemeStudioDraft, is_custom_theme_active: true };
            globalThemeStudioDirty = false;
            globalThemeWallpaperFile = null;
            document.getElementById("txtThemeBgUrl").value = imageUrl;
            if (globalThemeWallpaperPreviewUrl) URL.revokeObjectURL(globalThemeWallpaperPreviewUrl);
            globalThemeWallpaperPreviewUrl = "";
            if (themeFileName) themeFileName.textContent = "No image selected";
            clearFirestoreError("action");
            toast("Theme Wallpaper Published to Mobile App!");
            if (themeStudioStatus) themeStudioStatus.textContent = "Theme published";
            updateThemeStudioPreview();
        } catch (error) {
            toast(`Theme wallpaper update failed: ${error.message}`);
            if (themeStudioStatus) themeStudioStatus.textContent = "Publish failed";
            reportFirestoreError(error, "action");
        } finally {
            saveButton.disabled = false;
        }
    });

    Object.entries(modularThemeUrlFields).forEach(([inputId, field]) => {
        const input = document.getElementById(inputId);
        input.value = normalizeThemeWallpaperUrl(modularThemeDraft[field.key]);
        input.addEventListener("input", () => {
            const sanitizedUrl = normalizeThemeWallpaperUrl(input.value);
            if (input.value !== sanitizedUrl) input.value = sanitizedUrl;
            modularThemeDraft[field.key] = sanitizedUrl;
            modularThemeDirty = true;
            const preview = document.getElementById(field.preview);
            preview.src = sanitizedUrl;
            preview.hidden = !sanitizedUrl;
            preview.classList.toggle("has-preview", Boolean(sanitizedUrl));
        });
    });
    const modularToggle = document.getElementById("switchModularTheme");
    const modularAccent = document.getElementById("txtModAccent");
    const modularTitle = document.getElementById("txtModTitle");
    const modularMetric = document.getElementById("txtModMetric");
    modularToggle.checked = modularThemeDraft.is_modular_theme_active;
    modularAccent.value = modularThemeDraft.accent_color;
    modularTitle.value = modularThemeDraft.title_color;
    modularMetric.value = modularThemeDraft.metric_color;
    [
        [modularAccent, "accent_color"],
        [modularTitle, "title_color"],
        [modularMetric, "metric_color"]
    ].forEach(([input, key]) => {
        input.addEventListener("input", () => {
            modularThemeDraft[key] = input.value.trim();
            modularThemeDirty = true;
        });
    });
    modularToggle.addEventListener("change", () => {
        modularThemeDraft.is_modular_theme_active = modularToggle.checked;
        modularThemeDirty = true;
    });
    document.getElementById("btnDeployModularTheme")?.addEventListener("click", async event => {
        const deployButton = event.currentTarget;
        const status = document.getElementById("modularThemeStatus");
        const payload = {
            is_modular_theme_active: modularToggle.checked,
            root_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularRootBg").value),
            header_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularHeaderBg").value),
            bottom_nav_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularBottomNavBg").value),
            album_card_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularAlbumCardBg").value),
            text_card_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularTextCardBg").value),
            metric_pill_bg_url: normalizeThemeWallpaperUrl(document.getElementById("txtModularPillBg").value),
            accent_color: modularAccent.value.trim(),
            title_color: modularTitle.value.trim(),
            metric_color: modularMetric.value.trim(),
            updated_at: new Date().toISOString()
        };
        Object.entries(modularThemeUrlFields).forEach(([inputId, field]) => {
            document.getElementById(inputId).value = payload[field.key];
        });

        deployButton.disabled = true;
        if (status) status.textContent = "Deploying theme";
        try {
            await setDoc(doc(db, "app_config", "theme_engine"), payload, { merge: true });
            modularThemeData = { ...modularThemeData, ...payload };
            modularThemeDraft = { ...payload };
            modularThemeDirty = false;
            syncModularThemeControls();
            clearFirestoreError("action");
            if (status) status.textContent = "Theme deployed";
            toast("Modular Theme Successfully Deployed to All Users");
        } catch (error) {
            if (status) status.textContent = "Deployment failed";
            toast(`Modular theme deployment failed: ${error.message}`);
            reportFirestoreError(error, "action");
        } finally {
            deployButton.disabled = false;
        }
    });

    const proCardTemplate = document.getElementById("proCardConfigTemplate");
    const proCardSlot = document.getElementById("proCardConfigSlot");
    if (proCardTemplate && proCardSlot) {
        proCardSlot.append(proCardTemplate.content.cloneNode(true));
        const switchEl = document.getElementById("switchShowProCard");
        switchEl.checked = appConfigData.show_pro_card !== false;
        updateProCardStatus(switchEl.checked);
        switchEl.addEventListener("change", async () => {
            const showProCard = switchEl.checked;
            updateProCardStatus(showProCard);
            try {
                await setDoc(doc(db, "app_config", "global"), { show_pro_card: showProCard }, { merge: true });
                clearFirestoreError("action");
                toast(showProCard ? "PRO Card is now VISIBLE in app" : "PRO Card is now HIDDEN from app");
            } catch (error) {
                switchEl.checked = appConfigData.show_pro_card !== false;
                updateProCardStatus(switchEl.checked);
                toast(`Config update failed: ${error.message}`);
                reportFirestoreError(error, "action");
            }
        });
    }

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

function updateProCardStatus(isVisible) {
    const badge = document.getElementById("badgeProCardStatus");
    if (!badge) return;
    badge.textContent = isVisible ? "VISIBLE" : "HIDDEN";
    badge.classList.toggle("is-active", isVisible);
    badge.classList.toggle("is-disabled", !isVisible);
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

// TAB 7: APP UPDATE MANAGER
function renderAppUpdates(container) {
    const updateError = firestoreErrors["app-update"] || firestoreErrors.config;
    const data = appUpdateData;
    const versionEnabled = data.is_update_enabled ?? data.forceUpdate === true;
    const announcementEnabled = data.announcement_enabled ?? data.announcementEnabled ?? Boolean(data.announcement_banner ?? data.announcementBanner);
    const maintenanceMode = appConfigData.maintenance_mode ?? data.maintenance_mode ?? data.maintenanceMode ?? false;
    const latestVersionCode = data.latest_version_code ?? data.latestVersionCode ?? "";
    const latestVersionName = data.latest_version_name ?? data.versionName ?? "";
    const minSupportedVersion = data.min_supported_version ?? data.minimumSupportedVersion ?? "";
    const updateTitle = data.update_title ?? data.dialogTitle ?? "";
    const releaseNotes = data.release_notes ?? data.releaseNotes ?? "";
    const announcementText = data.announcement_banner ?? data.announcementBanner ?? "";
    const maintenanceMessage = data.maintenance_message ?? data.maintenanceMessage ?? "";

    container.innerHTML = `
        <section class="app-update-screen">
            <header class="app-update-heading">
                <div class="app-update-icon"><i class="fa-solid fa-sliders" aria-hidden="true"></i></div>
                <div>
                    <p class="module-eyebrow">Remote configuration</p>
                    <h3>App Update Manager</h3>
                    <p class="module-description">Configure app releases, in-app announcements, and service availability independently.</p>
                </div>
            </header>
            ${updateError ? `<div class="firestore-error" role="alert"><strong>${escapeHtml(updateError.title)}</strong><p>${escapeHtml(updateError.details)}</p></div>` : ""}
            ${!appUpdateLoaded ? '<p class="update-sync-note" role="status">Connecting to live update settings...</p>' : ""}
            <div class="app-update-form">
                <form id="formVersionControl" class="app-update-card settings-card" data-config-card="version">
                    <header class="settings-card-header">
                        <button class="card-heading-button" type="button" data-card-toggle aria-expanded="true" aria-controls="versionControlPanel">
                            <span class="settings-card-icon"><i class="fa-solid fa-code-branch" aria-hidden="true"></i></span>
                            <span class="settings-card-heading">
                                <strong>App Update &amp; Version Control</strong>
                                <small>Configure the release users will receive.</small>
                            </span>
                            <i class="fa-solid fa-chevron-down card-chevron" aria-hidden="true"></i>
                        </button>
                        <span id="versionControlStatus" class="config-status-badge ${versionEnabled ? "is-active" : "is-disabled"}" role="status">${versionEnabled ? "ACTIVE" : "DISABLED"}</span>
                        <label class="switch-control">
                            <input id="switchVersionControl" type="checkbox" role="switch" aria-label="Enable version control" ${versionEnabled ? "checked" : ""}>
                            <span class="switch-track" aria-hidden="true"></span>
                            <span class="switch-state" aria-hidden="true">${versionEnabled ? "On" : "Off"}</span>
                        </label>
                    </header>
                    <div class="settings-card-panel" id="versionControlPanel" aria-hidden="false">
                        <div class="settings-card-panel-inner">
                            <div class="settings-card-content">
                                <div class="update-field-grid">
                                    <label class="update-field">
                                        <span>Version Code</span>
                                        <input id="latestVersionCode" type="number" min="1" step="1" required value="${escapeHtml(latestVersionCode)}" placeholder="5">
                                    </label>
                                    <label class="update-field">
                                        <span>Version Name</span>
                                        <input id="latestVersionName" type="text" maxlength="40" required value="${escapeHtml(latestVersionName)}" placeholder="1.1.3">
                                    </label>
                                    <label class="update-field">
                                        <span>Minimum Supported Version</span>
                                        <input id="minSupportedVersion" type="number" min="0" step="1" required value="${escapeHtml(minSupportedVersion)}" placeholder="4">
                                    </label>
                                    <label class="update-field">
                                        <span>Update Dialog Title</span>
                                        <input id="updateTitle" type="text" maxlength="120" required value="${escapeHtml(updateTitle)}" placeholder="Google Sign-In &amp; Performance Fix">
                                    </label>
                                    <label class="update-field update-field-wide">
                                        <span>Release Notes</span>
                                        <textarea id="releaseNotes" rows="5" maxlength="4000" placeholder="Add release notes shown in the update dialog.">${escapeHtml(releaseNotes)}</textarea>
                                    </label>
                                </div>
                                <footer class="config-card-actions">
                                    <button class="config-save-button version-save-button" id="btnSaveVersionControl" type="submit" ${appUpdateLoaded && !savingAppUpdateCards.has("version") ? "" : "disabled"}>Save Version Settings</button>
                                </footer>
                            </div>
                        </div>
                    </div>
                </form>

                <form id="formAnnouncement" class="app-update-card settings-card announcement-card" data-config-card="announcement">
                    <header class="settings-card-header">
                        <button class="card-heading-button" type="button" data-card-toggle aria-expanded="true" aria-controls="announcementPanel">
                            <span class="settings-card-icon"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span>
                            <span class="settings-card-heading">
                                <strong>In-App Announcement</strong>
                                <small>Share a timely message with app users.</small>
                            </span>
                            <i class="fa-solid fa-chevron-down card-chevron" aria-hidden="true"></i>
                        </button>
                        <span id="announcementStatus" class="config-status-badge ${announcementEnabled ? "is-active" : "is-disabled"}" role="status">${announcementEnabled ? "LIVE" : "MUTED"}</span>
                        <label class="switch-control">
                            <input id="switchAnnouncement" type="checkbox" role="switch" aria-label="Enable in-app announcement" ${announcementEnabled ? "checked" : ""}>
                            <span class="switch-track" aria-hidden="true"></span>
                            <span class="switch-state" aria-hidden="true">${announcementEnabled ? "On" : "Off"}</span>
                        </label>
                    </header>
                    <div class="settings-card-panel" id="announcementPanel" aria-hidden="false">
                        <div class="settings-card-panel-inner">
                            <div class="settings-card-content">
                                <div class="update-field">
                                    <label for="announcementText">Announcement Text / Message</label>
                                    <textarea id="announcementText" rows="4" maxlength="1000" placeholder="Write the message shown in the app banner.">${escapeHtml(announcementText)}</textarea>
                                    <div id="announcementCharacterMeterMount"></div>
                                </div>
                                <footer class="config-card-actions">
                                    <button class="config-save-button announcement-save-button" id="btnSaveAnnouncement" type="submit" ${appUpdateLoaded && !savingAppUpdateCards.has("announcement") ? "" : "disabled"}>Publish Announcement</button>
                                </footer>
                            </div>
                        </div>
                    </div>
                </form>

                <form id="formMaintenance" class="app-update-card settings-card maintenance-card" data-config-card="maintenance">
                    <header class="settings-card-header">
                        <button class="card-heading-button" type="button" data-card-toggle aria-expanded="true" aria-controls="maintenancePanel">
                            <span class="settings-card-icon"><i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i></span>
                            <span class="settings-card-heading">
                                <strong>Maintenance Mode</strong>
                                <small>Emergency service availability control.</small>
                            </span>
                            <i class="fa-solid fa-chevron-down card-chevron" aria-hidden="true"></i>
                        </button>
                        <span id="maintenanceStatus" class="config-status-badge maintenance-status ${maintenanceMode ? "is-maintenance" : "is-system-live"}" role="status">${maintenanceMode ? "UNDER MAINTENANCE" : "SYSTEM LIVE"}</span>
                        <label class="switch-control">
                            <input id="switchMaintenance" type="checkbox" role="switch" aria-label="Enable maintenance mode" ${maintenanceMode ? "checked" : ""}>
                            <span class="switch-track" aria-hidden="true"></span>
                            <span class="switch-state" aria-hidden="true">${maintenanceMode ? "On" : "Off"}</span>
                        </label>
                    </header>
                    <div class="settings-card-panel" id="maintenancePanel" aria-hidden="false">
                        <div class="settings-card-panel-inner">
                            <div class="settings-card-content">
                                <label class="update-field">
                                    <span>Custom Maintenance Message</span>
                                    <textarea id="maintenanceMessage" rows="3" maxlength="500" placeholder="Scheduled maintenance in progress">${escapeHtml(maintenanceMessage)}</textarea>
                                </label>
                                <footer class="config-card-actions">
                                    <button class="config-save-button maintenance-save-button" id="btnSaveMaintenance" type="submit" ${appUpdateLoaded && !savingAppUpdateCards.has("maintenance") ? "" : "disabled"}>Apply Maintenance Mode</button>
                                </footer>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
        </section>
    `;

    const counterTemplate = document.getElementById("announcementCharacterMeterTemplate");
    const counterMount = document.getElementById("announcementCharacterMeterMount");
    if (!(counterTemplate instanceof HTMLTemplateElement) || !counterMount) {
        throw new Error("Announcement character meter template is missing");
    }
    counterMount.append(counterTemplate.content.cloneNode(true));

    container.querySelectorAll("[data-config-card]").forEach(card => {
        const cardKey = card.dataset.configCard;
        card.addEventListener("input", () => dirtyAppUpdateCards.add(cardKey));
        card.addEventListener("change", event => {
            dirtyAppUpdateCards.add(cardKey);
            const target = event.target;
            if (target instanceof HTMLInputElement && target.type === "checkbox") {
                updateAppUpdateStatus(cardKey, target.checked);
            }
        });
    });
    container.querySelectorAll("[data-card-toggle]").forEach(button => {
        button.addEventListener("click", () => {
            const card = button.closest(".settings-card");
            const panel = card?.querySelector(".settings-card-panel");
            const isExpanded = button.getAttribute("aria-expanded") === "true";
            button.setAttribute("aria-expanded", String(!isExpanded));
            card?.classList.toggle("is-collapsed", isExpanded);
            panel?.setAttribute("aria-hidden", String(isExpanded));
            if (panel) panel.toggleAttribute("inert", isExpanded);
        });
    });
    const announcementTextarea = document.getElementById("announcementText");
    announcementTextarea?.addEventListener("input", () => updateAnnouncementCharacterCounter(announcementTextarea));
    if (announcementTextarea) updateAnnouncementCharacterCounter(announcementTextarea);
    document.getElementById("formVersionControl")?.addEventListener("submit", saveVersionControl);
    document.getElementById("formAnnouncement")?.addEventListener("submit", saveAnnouncement);
    document.getElementById("formMaintenance")?.addEventListener("submit", saveMaintenanceMode);
}

function updateAnnouncementCharacterCounter(textarea) {
    const length = textarea.value.length;
    const counter = document.getElementById("announcementCharCounter");
    if (!counter) return;
    counter.innerText = `${length} / 1000`;
    counter.style.color = length === 1000 ? "#da3633" : length >= 900 ? "#d29922" : "#58a6ff";
}

function truncateAnnouncementText(text) {
    let result = "";
    for (const character of text) {
        if (result.length + character.length > 1000) break;
        result += character;
    }
    return result;
}

function updateAppUpdateStatus(cardKey, enabled) {
    const status = document.getElementById({
        version: "versionControlStatus",
        announcement: "announcementStatus",
        maintenance: "maintenanceStatus"
    }[cardKey]);
    const switchState = document.querySelector(`[data-config-card="${cardKey}"] .switch-state`);
    const enabledLabel = {
        version: "ACTIVE",
        announcement: "LIVE",
        maintenance: "UNDER MAINTENANCE"
    }[cardKey];
    const disabledLabel = {
        version: "DISABLED",
        announcement: "MUTED",
        maintenance: "SYSTEM LIVE"
    }[cardKey];
    switchState.textContent = enabled ? "On" : "Off";
    status.textContent = enabled ? enabledLabel : disabledLabel;
    status.classList.toggle("is-active", cardKey !== "maintenance" && enabled);
    status.classList.toggle("is-disabled", cardKey !== "maintenance" && !enabled);
    status.classList.toggle("is-maintenance", cardKey === "maintenance" && enabled);
    status.classList.toggle("is-system-live", cardKey === "maintenance" && !enabled);
}

function syncAppUpdateForm() {
    const data = appUpdateData;
    const versionEnabled = data.is_update_enabled ?? data.forceUpdate === true;
    const announcementEnabled = data.announcement_enabled ?? data.announcementEnabled ?? Boolean(data.announcement_banner ?? data.announcementBanner);
    const maintenanceMode = appConfigData.maintenance_mode ?? data.maintenance_mode ?? data.maintenanceMode ?? false;
    const syncCard = (cardKey, values, enabled) => {
        if (dirtyAppUpdateCards.has(cardKey)) return;
        for (const [id, value] of Object.entries(values)) {
            const field = document.getElementById(id);
            if (field) field.value = value ?? "";
        }
        const toggle = document.querySelector(`[data-config-card="${cardKey}"] input[role="switch"]`);
        if (toggle) {
            toggle.checked = enabled;
            updateAppUpdateStatus(cardKey, enabled);
        }
    };

    syncCard("version", {
        latestVersionCode: data.latest_version_code ?? data.latestVersionCode ?? "",
        latestVersionName: data.latest_version_name ?? data.versionName ?? "",
        minSupportedVersion: data.min_supported_version ?? data.minimumSupportedVersion ?? "",
        updateTitle: data.update_title ?? data.dialogTitle ?? "",
        releaseNotes: data.release_notes ?? data.releaseNotes ?? ""
    }, versionEnabled);
    syncCard("announcement", {
        announcementText: data.announcement_banner ?? data.announcementBanner ?? ""
    }, announcementEnabled);
    const announcementTextarea = document.getElementById("announcementText");
    if (announcementTextarea && !dirtyAppUpdateCards.has("announcement")) {
        updateAnnouncementCharacterCounter(announcementTextarea);
    }
    syncCard("maintenance", {
        maintenanceMessage: data.maintenance_message ?? data.maintenanceMessage ?? ""
    }, maintenanceMode);
}

async function saveAppUpdateCard(cardKey, buttonId, payload, successMessage, save) {
    if (savingAppUpdateCards.has(cardKey)) return;
    const button = document.getElementById(buttonId);
    if (!button || !appUpdateLoaded) return;

    const originalLabel = button.textContent;
    savingAppUpdateCards.add(cardKey);
    button.disabled = true;
    button.textContent = "Saving...";
    dirtyAppUpdateCards.add(cardKey);
    try {
        await save(payload);
        appUpdateData = { ...appUpdateData, ...payload };
        if (cardKey === "maintenance") appConfigData = { ...appConfigData, maintenance_mode: payload.maintenance_mode };
        dirtyAppUpdateCards.delete(cardKey);
        clearFirestoreError("app-update");
        clearFirestoreError("config");
        clearFirestoreError("action");
        if (!firestoreErrors["app-update"] && !firestoreErrors.config) {
            document.querySelector("#contentContainer .firestore-error")?.remove();
        }
        toast(successMessage);
        syncAppUpdateForm();
    } catch (error) {
        toast(`Unable to save ${cardKey} settings: ${error.message}`);
    } finally {
        savingAppUpdateCards.delete(cardKey);
        if (button.isConnected) {
            button.disabled = false;
            button.textContent = originalLabel;
        }
    }
}

async function saveVersionControl(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const latestVersionCode = Number(document.getElementById("latestVersionCode").value);
    const minSupportedVersion = Number(document.getElementById("minSupportedVersion").value);
    if (!Number.isInteger(latestVersionCode) || latestVersionCode < 1 ||
        !Number.isInteger(minSupportedVersion) || minSupportedVersion < 0 ||
        minSupportedVersion > latestVersionCode) {
        toast("Version codes must be whole numbers, and the minimum cannot exceed the latest version");
        return;
    }

    const payload = {
        is_update_enabled: document.getElementById("switchVersionControl").checked,
        latest_version_code: latestVersionCode,
        latest_version_name: document.getElementById("latestVersionName").value.trim(),
        min_supported_version: minSupportedVersion,
        update_title: document.getElementById("updateTitle").value.trim(),
        release_notes: document.getElementById("releaseNotes").value.trim(),
        updated_at: serverTimestamp()
    };
    await saveAppUpdateCard("version", "btnSaveVersionControl", payload, "Version Control Settings Saved",
        update => setDoc(doc(db, "app_config", "app_update"), update, { merge: true }));
}

async function saveAnnouncement(event) {
    event.preventDefault();
    const textarea = document.getElementById("announcementText");
    const announcementText = truncateAnnouncementText(textarea.value);
    textarea.value = announcementText;
    updateAnnouncementCharacterCounter(textarea);
    const payload = {
        announcement_enabled: document.getElementById("switchAnnouncement").checked,
        announcement_banner: announcementText.trim(),
        announcement_updated_at: serverTimestamp()
    };
    await saveAppUpdateCard("announcement", "btnSaveAnnouncement", payload, "Announcement Updated Successfully",
        update => setDoc(doc(db, "app_config", "app_update"), update, { merge: true }));
}

async function saveMaintenanceMode(event) {
    event.preventDefault();
    const payload = {
        maintenance_mode: document.getElementById("switchMaintenance").checked,
        maintenance_message: document.getElementById("maintenanceMessage").value.trim(),
        maintenance_updated_at: serverTimestamp()
    };
    await saveAppUpdateCard("maintenance", "btnSaveMaintenance", payload, "Maintenance Mode Updated", update => {
        const batch = writeBatch(db);
        batch.set(doc(db, "app_config", "global"), update, { merge: true });
        batch.set(doc(db, "app_config", "app_update"), update, { merge: true });
        return batch.commit();
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

function openProGrantModal(uid) {
    const modal = document.getElementById("proGrantModal");
    if (!modal) {
        toast("Unable to open PRO duration selector");
        return;
    }

    pendingProGrantUid = uid;
    modal.style.display = "flex";
    const close = () => {
        modal.style.display = "none";
        pendingProGrantUid = null;
    };

    document.getElementById("btnProGrantCancel").onclick = close;
    modal.querySelectorAll("[data-plan-name][data-days]").forEach(button => {
        button.onclick = () => {
            const selectedUid = pendingProGrantUid;
            const planName = button.dataset.planName;
            const days = Number(button.dataset.days);
            close();
            if (selectedUid && planName && Number.isInteger(days) && days > 0) {
                grantProPass(selectedUid, planName, days);
            }
        };
    });
}

async function grantProPass(uid, selectedPlanName, days) {
    try {
        await setDoc(doc(db, "users", uid), {
            isPro: true,
            proPlanName: selectedPlanName,
            proExpiresAt: new Date(Date.now() + days * 86400000).toISOString()
        }, { merge: true });
        clearFirestoreError("action");
        toast(`Granted ${selectedPlanName} (${days} Days) to user`);
    } catch (error) {
        toast(`Error granting PRO: ${error.message}`);
        reportFirestoreError(error, "action");
    }
}

window.adminTogglePro = async (uid, shouldBePro) => {
    if (shouldBePro) {
        openProGrantModal(uid);
        return;
    }

    confirmAction(
        "Revoke Anant PRO?",
        `Change ${uid} to Free Tier? This updates the user's membership immediately.`,
        async () => {
            try {
                await setDoc(doc(db, "users", uid), { isPro: false }, { merge: true });
                clearFirestoreError("action");
                toast("User updated: Free Tier");
            } catch (error) {
                toast(`Error updating user: ${error.message}`);
                reportFirestoreError(error, "action");
            }
        },
        "Revoke PRO"
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
        if (currentTab === "app_updates" && tab !== "app_updates") dirtyAppUpdateCards.clear();
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
