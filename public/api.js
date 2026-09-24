const API_BASE = window.VBG_API_BASE || "";

const Auth = {
  TOKEN_KEY: "vbg_token",
  REMEMBER_KEY: "vbg_remember",

  saveToken(token, remember) {
    localStorage.setItem(this.REMEMBER_KEY, remember ? "1" : "0");
    localStorage.setItem(this.TOKEN_KEY, token);
  },
  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },
  clear() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.REMEMBER_KEY);
  },
  isRemember() {
    return localStorage.getItem(this.REMEMBER_KEY) === "1";
  },
};

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = Auth.getToken();
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* kein JSON */
  }

  if (res.status === 401) {
    Auth.clear();
    window.dispatchEvent(new Event("vbg:logout"));
    throw new Error("Nicht angemeldet");
  }
  if (!res.ok) {
    throw new Error((data && data.error) || "Fehler " + res.status);
  }
  return data;
}

window.api = api;
window.Auth = Auth;