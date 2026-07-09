// --- Petits utilitaires ---

const $ = (id) => document.getElementById(id);
const todayISO = () => new Date().toISOString().slice(0, 10);

function showMsg(text, type) {
  $("msg").innerHTML = `<div class="msg ${type}">${text}</div>`;
}

// --- Compression de la photo (canvas, côté navigateur) ---

function compressImage(file, maxWidth = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- File d'attente hors-ligne (IndexedDB) ---

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("carte-postale-queue", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueAdd(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readonly");
    const req = tx.objectStore("queue").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueRemove(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Envoi au serveur ---

async function envoyer(entry) {
  const form = new FormData();
  form.append("pin", entry.pin);
  form.append("action", entry.action);
  form.append("date", entry.date);
  if (entry.action !== "delete") {
    form.append("lieu", entry.lieu);
    form.append("texte", entry.texte);
    if (entry.photoBlob) form.append("photo", entry.photoBlob, "photo.jpg");
  }
  const res = await fetch(`${CONFIG.SUPABASE_FUNCTIONS_URL}/post-carte`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur inconnue");
  return data;
}

async function retryQueue() {
  const items = await queueAll();
  if (items.length === 0) {
    $("queue-box").style.display = "none";
    return;
  }
  $("queue-box").style.display = "block";
  $("queue-list").innerHTML = items
    .map((it) => `${it.date} — ${it.action === "delete" ? "suppression" : it.lieu}`)
    .join("<br>");

  for (const item of items) {
    try {
      await envoyer(item);
      await queueRemove(item.id);
    } catch (e) {
      // toujours hors-ligne ou erreur serveur : on la garde pour la prochaine tentative
    }
  }
  const remaining = await queueAll();
  if (remaining.length === 0) {
    $("queue-box").style.display = "none";
    showMsg("Toutes les cartes en attente ont été envoyées.", "ok");
  } else {
    $("queue-list").innerHTML = remaining
      .map((it) => `${it.date} — ${it.action === "delete" ? "suppression" : it.lieu}`)
      .join("<br>");
  }
}

// --- Init page ---

$("date").value = todayISO();

const savedPin = sessionStorage.getItem("pin");
if (savedPin) $("pin").value = savedPin;

$("lieu").addEventListener("change", () => {
  $("lieu-autre").style.display = $("lieu").value === "autre" ? "block" : "none";
});

$("photo").addEventListener("change", () => {
  const f = $("photo").files[0];
  $("photo-info").textContent = f ? `${f.name} (${Math.round(f.size / 1024)} Ko avant compression)` : "";
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("pin").value.trim();
  const date = $("date").value;
  const lieu = $("lieu").value === "autre" ? $("lieu-autre").value.trim() : $("lieu").value;
  const texte = $("texte").value.trim();
  const photoFile = $("photo").files[0];

  if (!pin || !date || !lieu || !texte) {
    showMsg("Merci de remplir tous les champs.", "err");
    return;
  }

  $("submit-btn").disabled = true;
  $("submit-btn").textContent = "Envoi…";

  let photoBlob = null;
  if (photoFile) {
    try {
      photoBlob = await compressImage(photoFile);
    } catch (e) {
      showMsg("Impossible de traiter la photo.", "err");
      $("submit-btn").disabled = false;
      $("submit-btn").textContent = "Envoyer la carte";
      return;
    }
  }

  const entry = { pin, action: "upsert", date, lieu, texte, photoBlob };
  sessionStorage.setItem("pin", pin);

  try {
    await envoyer(entry);
    showMsg("Carte envoyée ✅", "ok");
    $("form").reset();
    $("date").value = todayISO();
    $("pin").value = pin;
  } catch (e) {
    if (!navigator.onLine) {
      await queueAdd(entry);
      showMsg("Pas de réseau : la carte sera envoyée automatiquement dès que possible.", "pending");
      retryQueue();
    } else {
      showMsg(`Erreur : ${e.message}`, "err");
    }
  } finally {
    $("submit-btn").disabled = false;
    $("submit-btn").textContent = "Envoyer la carte";
  }
});

$("delete-btn").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  const date = $("date").value;
  if (!pin || !date) {
    showMsg("Renseigne le code et la date.", "err");
    return;
  }
  if (!confirm(`Supprimer la carte du ${date} ?`)) return;

  const entry = { pin, action: "delete", date };
  try {
    await envoyer(entry);
    showMsg("Carte supprimée.", "ok");
  } catch (e) {
    if (!navigator.onLine) {
      await queueAdd(entry);
      showMsg("Pas de réseau : la suppression sera appliquée dès que possible.", "pending");
      retryQueue();
    } else {
      showMsg(`Erreur : ${e.message}`, "err");
    }
  }
});

window.addEventListener("online", retryQueue);
retryQueue();
