# backend/app.py
import os
import uuid
import base64
import sqlite3
import subprocess
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, render_template, redirect, url_for
from werkzeug.utils import secure_filename
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.lib.pagesizes import A4
from PyPDF2 import PdfReader, PdfWriter
from PIL import Image
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
CONTRACTS_DIR = DATA_DIR / "contracts"
PDFS_DIR = DATA_DIR / "pdfs"
SIGN_DIR = DATA_DIR / "signatures"
SIGNED_DIR = DATA_DIR / "signed"
DB_PATH = DATA_DIR / "db.sqlite3"

for d in (DATA_DIR, CONTRACTS_DIR, PDFS_DIR, SIGN_DIR, SIGNED_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, template_folder=str(BASE_DIR / "templates"), static_folder=str(BASE_DIR / "static"))

# ---------- Simple SQLite helpers ----------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        filename TEXT,
        pdf_filename TEXT,
        created_at TEXT,
        client_email TEXT,
        token TEXT,
        signing_status TEXT,
        signing_page INTEGER,
        signing_x REAL,
        signing_y REAL,
        signed_pdf TEXT
    )
    """)
    conn.commit()
    conn.close()

def db_execute(query, params=()):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(query, params)
    conn.commit()
    conn.close()

def db_fetchone(query, params=()):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(query, params)
    row = c.fetchone()
    conn.close()
    return row

init_db()

# ---------- Utilities ----------
def generate_contract_id():
    return "CN-" + datetime.utcnow().strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:6].upper()

def save_uploaded_docx(file_storage):
    filename = secure_filename(file_storage.filename)
    uid = uuid.uuid4().hex[:8]
    dest_name = f"{uid}_{filename}"
    dest_path = CONTRACTS_DIR / dest_name
    file_storage.save(dest_path)
    return dest_name, dest_path

def convert_docx_to_pdf(docx_path: Path, out_dir: Path):
    """
    Uses LibreOffice headless conversion. Requires libreoffice to be installed.
    Returns path to generated PDF.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # LibreOffice will output filename.pdf to out_dir
    subprocess.run([
        "libreoffice", "--headless", "--convert-to", "pdf",
        "--outdir", str(out_dir),
        str(docx_path)
    ], check=True)
    pdf_name = docx_path.with_suffix(".pdf").name
    return out_dir / pdf_name

def create_overlay_with_signature(sig_png_path: Path, page_width_pts, page_height_pts, place_x_pct, place_y_pct, sig_w_pts=None, sig_h_pts=None):
    """
    Create a single-page PDF overlay with signature placed at percentage coords.
    place_x_pct/place_y_pct in 0..1 (percentage across page width/height)
    Optionally provide signature width/height in points; else scale by 25% width.
    """
    overlay_path = SIGNED_DIR / f"overlay_{sig_png_path.stem}.pdf"
    c = pdfcanvas.Canvas(str(overlay_path), pagesize=(page_width_pts, page_height_pts))
    img = Image.open(sig_png_path)
    iw, ih = img.size

    # default signature width = 30% of page width
    if not sig_w_pts:
        sig_w_pts = page_width_pts * 0.30
    if not sig_h_pts:
        ratio = ih / iw if iw else 1
        sig_h_pts = sig_w_pts * ratio

    x = page_width_pts * place_x_pct - sig_w_pts/2
    # Note: ReportLab origin (0,0) is bottom-left; we get PDF top-origin y so convert:
    y = page_height_pts * (1 - place_y_pct) - sig_h_pts/2

    c.drawImage(str(sig_png_path), x, y, width=sig_w_pts, height=sig_h_pts, mask='auto')
    c.save()
    return overlay_path

def merge_overlay_onto_pdf(base_pdf_path: Path, overlay_pdf_path: Path, out_pdf_path: Path, target_page_index=0):
    base = PdfReader(str(base_pdf_path))
    overlay = PdfReader(str(overlay_pdf_path))
    writer = PdfWriter()

    for i, page in enumerate(base.pages):
        if i == target_page_index:
            page.merge_page(overlay.pages[0])
        writer.add_page(page)

    with open(out_pdf_path, "wb") as f:
        writer.write(f)
    return out_pdf_path

# ---------- API endpoints ----------

@app.route("/health")
def health():
    return jsonify({"status":"ok", "time": datetime.utcnow().isoformat()})

@app.route("/api/contracts/upload", methods=["POST"])
def upload_contract():
    """
    Upload a .docx contract. Returns contract_id and pdf url (converted).
    Expected form fields:
      - file: file upload (.docx)
      - client_email (optional)
    """
    if "file" not in request.files:
        return jsonify({"success": False, "message": "Missing file"}), 400
    f = request.files["file"]
    client_email = request.form.get("client_email", "")
    name, saved_path = save_uploaded_docx(f)
    contract_id = generate_contract_id()

    # Convert to PDF (LibreOffice)
    try:
        pdf_path = convert_docx_to_pdf(saved_path, PDFS_DIR)
    except subprocess.CalledProcessError as e:
        return jsonify({"success": False, "message": "Conversion failed. Ensure LibreOffice is installed on server.", "error": str(e)}), 500

    token = uuid.uuid4().hex[:32]
    db_execute("""
      INSERT INTO contracts (id, filename, pdf_filename, created_at, client_email, token, signing_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (contract_id, name, pdf_path.name, datetime.utcnow().isoformat(), client_email, token, "created"))

    pdf_url = url_for("serve_pdf", filename=pdf_path.name, _external=True)
    sign_link = url_for("sign_page", contract_id=contract_id, token=token, _external=True)
    return jsonify({"success": True, "contract_id": contract_id, "pdf": pdf_url, "sign_link": sign_link})

@app.route("/pdfs/<path:filename>")
def serve_pdf(filename):
    return send_from_directory(str(PDFS_DIR), filename)

@app.route("/signed/<path:filename>")
def serve_signed(filename):
    return send_from_directory(str(SIGNED_DIR), filename)

@app.route("/sign/<contract_id>/<token>")
def sign_page(contract_id, token):
    """
    Serve the client signing page.
    """
    # validate token
    row = db_fetchone("SELECT token, pdf_filename FROM contracts WHERE id=?", (contract_id,))
    if not row:
        return "Invalid contract", 404
    stored_token, pdf_filename = row
    if stored_token != token:
        return "Invalid token", 403
    # Render sign page template (loads the PDF viewer & signature UI)
    pdf_url = url_for("serve_pdf", filename=pdf_filename)
    return render_template("sign.html", contract_id=contract_id, token=token, pdf_url=pdf_url)

@app.route("/api/signature/save", methods=["POST"])
def save_signature_and_merge():
    """
    Receives JSON:
    {
      "contract_id": "...",
      "token": "...",
      "signature": "data:image/png;base64,...." OR {"type":"text", "text":"..."},
      "page": 0-based integer (default 0),
      "x_pct": 0.5,  # 0..1 percentage across width
      "y_pct": 0.85  # 0..1 percentage top->bottom fraction
    }
    """
    data = request.json or {}
    contract_id = data.get("contract_id")
    token = data.get("token")
    signature = data.get("signature")
    page_index = int(data.get("page", 0))
    x_pct = float(data.get("x_pct", 0.5))
    y_pct = float(data.get("y_pct", 0.85))

    row = db_fetchone("SELECT token, pdf_filename FROM contracts WHERE id=?", (contract_id,))
    if not row:
        return jsonify({"success": False, "message": "Contract not found"}), 404
    stored_token, pdf_filename = row
    if stored_token != token:
        return jsonify({"success": False, "message": "Invalid token"}), 403

    # Save signature image
    sig_name = f"{contract_id}_{uuid.uuid4().hex[:8]}.png"
    sig_path = SIGN_DIR / sig_name

    if isinstance(signature, dict) and signature.get("type") == "text":
        # Render text to an image
        text = signature.get("text", "").strip()
        if not text:
            return jsonify({"success": False, "message": "Empty text signature"}), 400
        # create image with PIL
        img = Image.new("RGBA", (800, 200), (255,255,255,0))
        from PIL import ImageDraw, ImageFont
        draw = ImageDraw.Draw(img)
        # Note: user may provide font path via env if needed
        try:
            font = ImageFont.truetype(os.getenv("SIGN_FONT_PATH", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"), 48)
        except Exception:
            font = ImageFont.load_default()
        draw.text((10,40), text, fill=(0,0,0,255), font=font)
        img.save(sig_path)
    else:
        # Expect data URL
        if not signature or not isinstance(signature, str) or not signature.startswith("data:"):
            return jsonify({"success": False, "message": "Invalid signature format"}), 400
        header, b64 = signature.split(",", 1)
        sig_bytes = base64.b64decode(b64)
        with open(sig_path, "wb") as fh:
            fh.write(sig_bytes)

    # Merge signature onto PDF
    base_pdf_path = PDFS_DIR / pdf_filename
    if not base_pdf_path.exists():
        return jsonify({"success": False, "message": "Base PDF not found"}), 404

    # get page size from pdf (in points)
    reader = PdfReader(str(base_pdf_path))
    if page_index < 0 or page_index >= len(reader.pages):
        return jsonify({"success": False, "message": "Invalid page index"}), 400
    page = reader.pages[page_index]
    mediabox = page.mediabox
    width_pts = float(mediabox.width)
    height_pts = float(mediabox.height)

    overlay_pdf = create_overlay_with_signature(sig_path, width_pts, height_pts, x_pct, y_pct)
    out_pdf = SIGNED_DIR / f"{contract_id}_SIGNED_{uuid.uuid4().hex[:6]}.pdf"
    merged = merge_overlay_onto_pdf(base_pdf_path, overlay_pdf, out_pdf, target_page_index=page_index)

    # update DB
    db_execute("""
      UPDATE contracts
      SET signing_status = ?, signing_page = ?, signing_x = ?, signing_y = ?, signed_pdf = ?
      WHERE id = ?
    """, ("signed", page_index, x_pct, y_pct, merged.name, contract_id))

    signed_url = url_for("serve_signed", filename=merged.name, _external=True)
    return jsonify({"success": True, "signed_pdf_url": signed_url})

# Static route for simple file uploads in UI (optional)
@app.route("/upload_ui", methods=["GET"])
def upload_ui():
    # Very small helper page to upload docx via browser
    return """
    <html><body>
    <h3>Upload contract (.docx)</h3>
    <form action="/api/contracts/upload" method="post" enctype="multipart/form-data">
    file: <input type="file" name="file"/><br/>
    client_email: <input type="email" name="client_email"/><br/>
    <button type="submit">Upload</button>
    </form>
    </body></html>
    """

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 8000)), debug=True)
