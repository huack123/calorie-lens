'use strict';

const DEFAULT_GOAL = 2000;
const MAX_IMAGE_EDGE = 1024;

const els = {
  boot: document.getElementById('boot'),
  authScreen: document.getElementById('auth-screen'),
  googleSignin: document.getElementById('google-signin'),
  googleLabel: document.getElementById('google-label'),
  authError: document.getElementById('auth-error'),
  app: document.getElementById('app'),
  userEmail: document.getElementById('user-email'),
  avatar: document.getElementById('avatar'),
  signout: document.getElementById('signout'),
  meal: document.getElementById('meal'),
  cameraBtn: document.getElementById('camera-btn'),
  cameraDialog: document.getElementById('camera-dialog'),
  cameraVideo: document.getElementById('camera-video'),
  cameraStatus: document.getElementById('camera-status'),
  cameraError: document.getElementById('camera-error'),
  cameraCapture: document.getElementById('camera-capture'),
  cameraCancel: document.getElementById('camera-cancel'),
  cameraClose: document.getElementById('camera-close'),
  photoBtn: document.getElementById('photo-btn'),
  photo: document.getElementById('photo'),
  analyze: document.getElementById('analyze'),
  preview: document.getElementById('preview'),
  previewImg: document.getElementById('preview-img'),
  removePhoto: document.getElementById('remove-photo'),
  error: document.getElementById('error'),
  result: document.getElementById('result'),
  resultTotal: document.getElementById('result-total'),
  resultItems: document.getElementById('result-items'),
  resultMacros: document.getElementById('result-macros'),
  add: document.getElementById('add'),
  goal: document.getElementById('goal'),
  todayDate: document.getElementById('today-date'),
  consumed: document.getElementById('consumed'),
  remaining: document.getElementById('remaining'),
  remainingStat: document.getElementById('remaining-stat'),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  macroTotal: document.getElementById('macro-total'),
  log: document.getElementById('log'),
  emptyLog: document.getElementById('empty-log'),
};

let supabaseClient = null;
let user = null;
let loadedUserId = null;
let photoDataUrl = null;
let cameraStream = null;
let analysis = null;
let entries = [];
let goal = DEFAULT_GOAL;

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function normalizeGoal(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_GOAL;
  return Math.min(10_000, Math.max(500, number));
}

function showScreen(name) {
  els.boot.hidden = name !== 'boot';
  els.authScreen.hidden = name !== 'auth';
  els.app.hidden = name !== 'app';
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
}

function hideAuthError() {
  els.authError.hidden = true;
}

function setLoading(loading) {
  els.analyze.disabled = loading;
  els.analyze.classList.toggle('is-loading', loading);
  els.analyze.textContent = loading ? 'Estimating…' : 'Estimate calories';
}

function mapMealRow(row) {
  return {
    id: row.id,
    name: row.name,
    portion: row.portion || '',
    calories: Number(row.calories) || 0,
    protein_g: Number(row.protein_g) || 0,
    carbs_g: Number(row.carbs_g) || 0,
    fat_g: Number(row.fat_g) || 0,
    at: row.created_at,
    date: row.eaten_on,
  };
}

function resetWorkspace() {
  closeCamera();
  analysis = null;
  photoDataUrl = null;
  entries = [];
  goal = DEFAULT_GOAL;

  els.result.hidden = true;
  els.preview.hidden = true;
  els.previewImg.removeAttribute('src');
  els.photo.value = '';
  els.meal.value = '';
  els.add.disabled = false;
  els.add.textContent = 'Add to today';
  hideError();
  renderToday();
}

function renderAccount() {
  const metadata = user?.user_metadata ?? {};
  els.userEmail.textContent = user?.email || '';

  const avatarUrl = metadata.avatar_url || metadata.picture;
  if (avatarUrl) {
    els.avatar.src = avatarUrl;
    els.avatar.hidden = false;
  } else {
    els.avatar.removeAttribute('src');
    els.avatar.hidden = true;
  }
}

async function handleSession(newSession) {
  user = newSession?.user ?? null;

  if (!user) {
    loadedUserId = null;
    resetWorkspace();
    showScreen('auth');
    return;
  }

  renderAccount();
  showScreen('app');

  if (loadedUserId === user.id) return;
  loadedUserId = user.id;
  await loadUserData();
}

async function loadUserData() {
  const requestUserId = user.id;
  els.emptyLog.hidden = false;
  els.emptyLog.textContent = 'Loading your log…';

  const [mealsResult, profileResult] = await Promise.all([
    supabaseClient
      .from('meals')
      .select('*')
      .eq('eaten_on', todayKey())
      .order('created_at', { ascending: true }),
    supabaseClient.from('profiles').select('calorie_goal').eq('id', requestUserId).maybeSingle(),
  ]);

  if (user?.id !== requestUserId) return;

  if (mealsResult.error || profileResult.error) {
    console.error('Could not load user data:', mealsResult.error || profileResult.error);
    els.emptyLog.textContent = 'Could not load your log.';
    showError(
      'Could not load your data. Run supabase/schema.sql in the Supabase SQL editor, then reload.',
    );
    return;
  }

  entries = (mealsResult.data || []).map(mapMealRow);
  goal = normalizeGoal(profileResult.data?.calorie_goal ?? DEFAULT_GOAL);

  if (!profileResult.data) {
    const { error } = await supabaseClient
      .from('profiles')
      .upsert(
        { id: user.id, calorie_goal: goal },
        { onConflict: 'id', ignoreDuplicates: true },
      );
    if (error) console.warn('Could not create profile:', error.message);
  }

  renderToday();
}

async function analyzeMeal() {
  if (els.analyze.disabled || !supabaseClient) return;

  const description = els.meal.value.trim();
  if (!description && !photoDataUrl) {
    showError('Describe the meal or attach a photo first.');
    els.meal.focus();
    return;
  }

  hideError();
  setLoading(true);

  try {
    const {
      data: { session: currentSession },
    } = await supabaseClient.auth.getSession();
    if (!currentSession) {
      throw new Error('Your session expired. Sign in again.');
    }

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentSession.access_token}`,
      },
      body: JSON.stringify({
        description,
        image: photoDataUrl || undefined,
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `The request failed (${response.status}).`);
    }
    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
      throw new Error('No meal data came back. Try again.');
    }

    analysis = data;
    renderAnalysis();
  } catch (error) {
    const message =
      error instanceof TypeError
        ? 'Could not reach the server. Is it running?'
        : error.message;
    showError(message);
  } finally {
    setLoading(false);
  }
}

function renderAnalysis() {
  els.resultTotal.textContent = `${analysis.total.calories.toLocaleString()} kcal`;
  els.resultItems.replaceChildren();

  for (const item of analysis.items) {
    const li = document.createElement('li');
    li.className =
      'list-group-item px-0 py-3 d-flex justify-content-between align-items-baseline gap-3';

    const main = document.createElement('div');
    main.className = 'd-flex flex-column min-w-0';

    const name = document.createElement('span');
    name.className = 'fw-medium';
    name.textContent = item.name;
    main.append(name);

    if (item.portion) {
      const portion = document.createElement('span');
      portion.className = 'small text-secondary';
      portion.textContent = item.portion;
      main.append(portion);
    }

    const side = document.createElement('div');
    side.className = 'text-end flex-shrink-0';

    const kcal = document.createElement('span');
    kcal.className = 'item-kcal d-block';
    kcal.textContent = `${item.calories.toLocaleString()} kcal`;
    side.append(kcal);

    const macros = document.createElement('span');
    macros.className = 'small text-secondary';
    macros.textContent = `P ${item.protein_g} · C ${item.carbs_g} · F ${item.fat_g}`;
    side.append(macros);

    li.append(main, side);
    els.resultItems.append(li);
  }

  els.resultMacros.replaceChildren(
    ...['protein_g', 'carbs_g', 'fat_g'].map((key) => {
      const pill = document.createElement('span');
      pill.className = 'badge rounded-pill macro-pill';
      const label = key === 'protein_g' ? 'Protein' : key === 'carbs_g' ? 'Carbs' : 'Fat';
      pill.textContent = `${label} ${analysis.total[key]} g`;
      return pill;
    }),
  );

  els.add.disabled = false;
  els.add.textContent = 'Add to today';
  els.result.hidden = false;

  if (window.matchMedia('(max-width: 820px)').matches) {
    els.result.scrollIntoView({ block: 'nearest' });
  }
}

async function addToToday() {
  if (!analysis || els.add.disabled || !user) return;

  const rows = analysis.items.map((item) => ({
    user_id: user.id,
    name: item.name,
    portion: item.portion || null,
    calories: item.calories,
    protein_g: item.protein_g,
    carbs_g: item.carbs_g,
    fat_g: item.fat_g,
    eaten_on: todayKey(),
  }));

  els.add.disabled = true;
  els.add.textContent = 'Saving…';

  const { data, error } = await supabaseClient.from('meals').insert(rows).select();

  if (error) {
    console.error('Could not save meal:', error);
    showError('Could not save this meal. Check your connection and try again.');
    els.add.disabled = false;
    els.add.textContent = 'Add to today';
    return;
  }

  entries.push(...(data || []).map(mapMealRow));
  renderToday();
  els.add.textContent = 'Added to today';
}

function renderToday() {
  els.goal.value = String(goal);
  els.todayDate.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const todays = entries
    .filter((entry) => entry.date === todayKey())
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const totals = todays.reduce(
    (acc, entry) => {
      acc.calories += entry.calories;
      acc.protein += Number(entry.protein_g) || 0;
      acc.carbs += Number(entry.carbs_g) || 0;
      acc.fat += Number(entry.fat_g) || 0;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  els.consumed.textContent = totals.calories.toLocaleString();

  const remaining = goal - totals.calories;
  els.remaining.textContent = Math.abs(remaining).toLocaleString();
  els.remainingStat.classList.toggle('over', remaining < 0);
  els.remainingStat.querySelector('small').textContent =
    remaining < 0 ? 'over goal' : 'remaining';

  els.meterFill.style.width = `${Math.min(100, (totals.calories / goal) * 100)}%`;
  els.meterFill.classList.toggle('over', totals.calories > goal);
  els.meter.setAttribute('aria-valuemax', String(goal));
  els.meter.setAttribute('aria-valuenow', String(Math.min(totals.calories, goal)));

  if (todays.length) {
    els.macroTotal.hidden = false;
    els.macroTotal.textContent = `Protein ${round1(totals.protein)} g · Carbs ${round1(totals.carbs)} g · Fat ${round1(totals.fat)} g`;
  } else {
    els.macroTotal.hidden = true;
  }

  els.log.replaceChildren();
  for (const entry of [...todays].reverse()) {
    const li = document.createElement('li');
    li.className =
      'list-group-item px-0 py-2 d-flex align-items-center justify-content-between gap-3';

    const main = document.createElement('div');
    main.className = 'd-flex flex-column min-w-0';

    const name = document.createElement('span');
    name.className = 'fw-medium log-name';
    name.textContent = entry.name;
    main.append(name);

    if (entry.portion) {
      const portion = document.createElement('span');
      portion.className = 'small text-secondary';
      portion.textContent = entry.portion;
      main.append(portion);
    }

    const side = document.createElement('div');
    side.className = 'd-flex align-items-center gap-2 flex-shrink-0';

    const kcal = document.createElement('span');
    kcal.className = 'log-kcal';
    kcal.textContent = entry.calories.toLocaleString();
    side.append(kcal);

    const remove = document.createElement('button');
    remove.className = 'log-delete';
    remove.type = 'button';
    remove.textContent = '×';
    remove.dataset.id = entry.id;
    remove.setAttribute('aria-label', `Remove ${entry.name}`);
    side.append(remove);

    li.append(main, side);
    els.log.append(li);
  }

  els.emptyLog.textContent = 'Nothing logged yet today.';
  els.emptyLog.hidden = todays.length > 0;
}

async function handlePhoto(file) {
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showError('That file is not an image.');
    return;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    photoDataUrl = canvas.toDataURL('image/jpeg', 0.82);
    els.previewImg.src = photoDataUrl;
    els.preview.hidden = false;
    hideError();
  } catch {
    showError('Could not read that image. Try a JPEG or PNG.');
  } finally {
    els.photo.value = '';
  }
}

function removePhoto() {
  photoDataUrl = null;
  els.photo.value = '';
  els.previewImg.removeAttribute('src');
  els.preview.hidden = true;
}

function showCameraError(message) {
  els.cameraError.textContent = message;
  els.cameraError.hidden = false;
}

function stopCamera() {
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  els.cameraVideo.srcObject = null;
  els.cameraCapture.disabled = true;
}

function closeCamera() {
  stopCamera();
  if (els.cameraDialog.open) els.cameraDialog.close();
}

async function openCamera() {
  if (els.cameraDialog.open) return;

  if (typeof els.cameraDialog.showModal !== 'function') {
    showError('Camera preview is not supported in this browser. Use Add photo instead.');
    return;
  }

  hideError();
  els.cameraError.hidden = true;
  els.cameraStatus.hidden = false;
  els.cameraStatus.textContent = 'Starting camera…';
  els.cameraCapture.disabled = true;
  els.cameraDialog.showModal();

  if (!navigator.mediaDevices?.getUserMedia) {
    els.cameraStatus.hidden = true;
    showCameraError('Camera is not available here. Use Add photo instead.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    if (!els.cameraDialog.open) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    cameraStream = stream;
    els.cameraVideo.srcObject = stream;
    await els.cameraVideo.play().catch(() => {});
    els.cameraStatus.hidden = true;
  } catch (error) {
    els.cameraStatus.hidden = true;
    const messages = {
      NotAllowedError:
        'Camera permission was denied. Allow camera access in your browser, or use Add photo.',
      SecurityError: 'Camera needs HTTPS or localhost. Use Add photo instead.',
      NotFoundError: 'No camera found. Use Add photo instead.',
      NotReadableError: 'The camera is busy in another app. Close it and try again.',
      OverconstrainedError: 'No suitable camera found. Use Add photo instead.',
    };
    showCameraError(messages[error.name] || 'Could not start the camera. Use Add photo instead.');
  }
}

function capturePhoto() {
  if (!cameraStream || !els.cameraVideo.videoWidth) {
    showCameraError('Camera is still starting. Try again in a moment.');
    return;
  }

  const video = els.cameraVideo;
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  photoDataUrl = canvas.toDataURL('image/jpeg', 0.82);
  els.previewImg.src = photoDataUrl;
  els.preview.hidden = false;
  hideError();
  closeCamera();
}

async function signInWithGoogle() {
  if (!supabaseClient) return;

  hideAuthError();
  els.googleSignin.disabled = true;
  els.googleLabel.textContent = 'Redirecting…';

  // Supabase matches allow-list entries exactly, including the trailing slash at the root.
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });

  if (error) {
    showAuthError(error.message);
    els.googleSignin.disabled = false;
    els.googleLabel.textContent = 'Continue with Google';
  }
}

async function signOut() {
  if (!supabaseClient) return;

  els.signout.disabled = true;
  const { error } = await supabaseClient.auth.signOut();
  els.signout.disabled = false;

  if (error) showError('Could not sign out. Try again.');
}

async function boot() {
  showScreen('boot');

  try {
    const response = await fetch('/api/config');
    const config = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(config?.error || 'Could not load app configuration.');
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  } catch (error) {
    showAuthError(error.message);
    els.googleSignin.disabled = true;
    showScreen('auth');
    return;
  }

  supabaseClient.auth.onAuthStateChange((_event, newSession) => {
    void handleSession(newSession);
  });

  const { data } = await supabaseClient.auth.getSession();
  await handleSession(data.session);
}

function init() {
  renderToday();

  els.googleSignin.addEventListener('click', signInWithGoogle);
  els.signout.addEventListener('click', signOut);
  els.cameraBtn.addEventListener('click', openCamera);
  els.cameraCapture.addEventListener('click', capturePhoto);
  els.cameraCancel.addEventListener('click', closeCamera);
  els.cameraClose.addEventListener('click', closeCamera);
  els.cameraDialog.addEventListener('close', stopCamera);
  els.cameraVideo.addEventListener('loadedmetadata', () => {
    els.cameraCapture.disabled = false;
  });
  window.addEventListener('pagehide', stopCamera);
  els.photoBtn.addEventListener('click', () => els.photo.click());
  els.photo.addEventListener('change', () => handlePhoto(els.photo.files?.[0]));
  els.removePhoto.addEventListener('click', removePhoto);
  els.analyze.addEventListener('click', analyzeMeal);
  els.add.addEventListener('click', addToToday);

  els.goal.addEventListener('change', async () => {
    goal = normalizeGoal(els.goal.value);
    renderToday();

    if (!user) return;
    const { error } = await supabaseClient
      .from('profiles')
      .upsert({ id: user.id, calorie_goal: goal });
    if (error) showError('Could not save your daily goal. Try again.');
  });

  els.log.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button || button.disabled) return;

    button.disabled = true;
    const { error } = await supabaseClient
      .from('meals')
      .delete()
      .eq('id', button.dataset.id);

    if (error) {
      console.error('Could not delete meal:', error);
      showError('Could not remove that entry. Try again.');
      button.disabled = false;
      return;
    }

    entries = entries.filter((entry) => entry.id !== button.dataset.id);
    renderToday();
  });

  els.meal.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      analyzeMeal();
    }
  });

  void boot();
}

init();
