import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyA4XN_xT6WroBZl6ZzPZ_UvGmHrm-6VU6w",
    authDomain: "my-photo-d96e9.firebaseapp.com",
    projectId: "my-photo-d96e9",
    storageBucket: "my-photo-d96e9.firebasestorage.app",
    messagingSenderId: "467289242886",
    appId: "1:467289242886:web:2fdb862c36956befcdf287"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
