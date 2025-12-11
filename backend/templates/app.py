<!-- backend/templates/sign.html -->
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>توقيع العقد</title>
  <style>
    body { font-family: Cairo, Arial, sans-serif; margin:16px; }
    #viewer { width:100%; height:70vh; border:1px solid #ddd; }
    #controls { margin-top:10px; display:flex; gap:8px; align-items:center; }
    .btn { padding:8px 12px; border-radius:8px; cursor:pointer; background:#0a84ff; color:white; border:none; }
    #hotspots { position:relative; }
    #hotspotOverlay { position:absolute; left:0; top:0; right:0; bottom:0; pointer-events:none; }
    .hotspot { position:absolute; width:48px; height:28px; background:rgba(255,136,0,0.9); color:#fff; display:flex; align-items:center; justify-content:center; border-radius:6px; cursor:pointer; pointer-events:auto;}
    #signModal { display:none; position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); background:#fff; padding:16px; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,0.2); z-index:9999;}
    #drawCanvas { border:1px solid #ccc; width:600px; height:200px; touch-action:none; }
  </style>
</head>
<body>
  <h2>توقيع العقد</h2>
  <p>مرحباً — الرجاء الضغط على أيقونة "وقع هنا" في المكان الذي تريد توقيعه ثم أكمل التوقيع.</p>

  <div id="viewerWrap" style="position:relative;">
    <iframe id="viewer" src="{{ pdf_url }}"></iframe>
    <!-- hotspot overlay could be used if you render PDF pages to images client-side; for simplicity, we capture click in iframe area -->
  </div>

  <div id="controls">
    <button class="btn" id="placeHotspotBtn">اضغط لوضع علامة "وقع هنا"</button>
    <div id="status" style="margin-left:12px;color:green"></div>
  </div>

  <div id="signModal">
    <h3>اختر طريقة التوقيع</h3>
    <button id="useDraw" class="btn">✍️ رسم</button>
    <button id="useText" class="btn">🅰️ كتابة نص</button>
    <div id="drawArea" style="margin-top:10px; display:none;">
      <canvas id="drawCanvas"></canvas>
      <div style="margin-top:8px;">
        <button id="clearDraw" class="btn" style="background:#777">مسح</button>
        <button id="saveDraw" class="btn">حفظ وإرسال التوقيع</button>
      </div>
    </div>
    <div id="textArea" style="margin-top:10px; display:none;">
      <input id="textInput" placeholder="اكتب توقيعك هنا" style="width:100%;padding:8px;font-size:18px;" />
      <div style="margin-top:8px;">
        <button id="saveText" class="btn">حفظ وإرسال</button>
      </div>
    </div>
  </div>

<script src="/static/signature-pad.js"></script>
<script>
const contractId = "{{ contract_id }}";
const token = "{{ token }}";
const viewer = document.getElementById("viewer");
const placeBtn = document.getElementById("placeHotspotBtn");
const status = document.getElementById("status");

let placing = false;
let lastClickNormalized = null; // {x_pct, y_pct}

placeBtn.addEventListener("click", () => {
  placing = true;
  status.textContent = "انقر داخل نافذة المعاينة في المكان الذي تريد أن يظهر به الزر 'وقع هنا' لدى العميل.";
});

// We'll approximate coordinates by capturing click relative to iframe element (note: if PDF inside cross-origin iframe, clicks are not capturable; this works best when PDF served from same origin)
document.getElementById("viewerWrap").addEventListener("click", (ev) => {
  if (!placing) return;
  const rect = viewer.getBoundingClientRect();
  // Use click position relative to iframe element
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  // Normalize 0..1 (Note: this is relative to iframe rendered box; PDF page sizes can differ.)
  const x_pct = x / rect.width;
  const y_pct = y / rect.height;
  lastClickNormalized = { x_pct: x_pct, y_pct: y_pct };
  placing = false;
  status.textContent = `تم وضع العلامة عند: x=${(x_pct*100).toFixed(1)}% y=${(y_pct*100).toFixed(1)}% — الآن افتح نافذة التوقيع للعميل أو أرسل الرابط.`;
  // Show sign modal immediately:
  openSignModal();
});

function openSignModal(){
  document.getElementById("signModal").style.display = "block";
}

const drawCanvas = document.getElementById("drawCanvas");
const drawArea = document.getElementById("drawArea");
const textArea = document.getElementById("textArea");
const useDraw = document.getElementById("useDraw");
const useText = document.getElementById("useText");

let signaturePad = null;

useDraw.addEventListener("click", () => {
  drawArea.style.display = "block";
  textArea.style.display = "none";
  // initialize signature pad on canvas
  drawCanvas.width = 600; drawCanvas.height = 200;
  signaturePad = new SignaturePad(drawCanvas, { backgroundColor: 'rgba(255,255,255,0)' });
});

useText.addEventListener("click", () => {
  drawArea.style.display = "none";
  textArea.style.display = "block";
});

document.getElementById("clearDraw").addEventListener("click", () => {
  if (signaturePad) signaturePad.clear();
});

document.getElementById("saveDraw").addEventListener("click", async () => {
  if (!signaturePad || signaturePad.isEmpty()) { alert("الرجاء رسم توقيعك أو اختر خيار الكتابة"); return; }
  const dataUrl = signaturePad.toDataURL();
  await submitSignature(dataUrl);
});

document.getElementById("saveText").addEventListener("click", async () => {
  const txt = document.getElementById("textInput").value.trim();
  if (!txt) return alert("اكتب توقيعك");
  // send as text signature
  await submitSignature({ type: "text", text: txt });
});

async function submitSignature(signaturePayload){
  if (!lastClickNormalized) {
    alert("لم يتم تحديد نقطة التوقيع. استخدم زر 'ضع علامة' ثم انقر في مكان داخل المعاينة.");
    return;
  }
  const payload = {
    contract_id: contractId,
    token: token,
    signature: signaturePayload,
    page: 0, // by default page 0; could be extended to choose page
    x_pct: lastClickNormalized.x_pct,
    y_pct: lastClickNormalized.y_pct
  };
  const res = await fetch("/api/signature/save", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.success) {
    alert("تم توقيع العقد وحفظه. يمكنك تحميل النسخة الموقعة الآن.");
    // show link
    window.location = data.signed_pdf_url;
  } else {
    alert("خطأ: " + (data.message || "فشل الحفظ"));
  }
}
</script>
</body>
</html>
