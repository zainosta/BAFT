"""
signature_app.py

Simple signature/drawing app using Tkinter.

Requirements:
    pip install Pillow
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from PIL import Image, ImageDraw

class SignatureApp:
    def __init__(self, root, width=800, height=300, bg=(255,255,255,0)):
        self.root = root
        self.root.title("Signature / Draw")
        self.width = width
        self.height = height
        self.bg_color = bg  # RGBA background for saved PNG (transparent by default)
        self.pen_color = (0, 0, 0, 255)  # black
        self.eraser_color = self.bg_color
        self.pen_width = 3
        self.eraser_width = 20
        self.mode = "draw"  # or "erase"

        # Strokes: list of dicts: { 'points': [(x,y), ...], 'width': int, 'color': (r,g,b,a) }
        self.strokes = []
        self.current_stroke = None

        # Create PIL image (RGBA) to mirror canvas content for direct saving
        self.image = Image.new("RGBA", (self.width, self.height), self.bg_color)
        self.draw = ImageDraw.Draw(self.image)

        self._build_ui()
        self._bind_events()
        self.redraw_canvas()

    def _build_ui(self):
        frame = ttk.Frame(self.root)
        frame.pack(fill="both", expand=True, padx=8, pady=8)

        # Canvas
        self.canvas = tk.Canvas(frame, width=self.width, height=self.height, bg="white", cursor="cross")
        self.canvas.grid(row=0, column=0, columnspan=6, sticky="nsew", pady=(0,8))

        # Controls
        ttk.Label(frame, text="Pen width:").grid(row=1, column=0, sticky="w")
        self.width_var = tk.IntVar(value=self.pen_width)
        width_spin = ttk.Spinbox(frame, from_=1, to=50, textvariable=self.width_var, width=5, command=self._change_width)
        width_spin.grid(row=1, column=1, sticky="w")

        self.mode_var = tk.StringVar(value="draw")
        draw_btn = ttk.Radiobutton(frame, text="Draw", variable=self.mode_var, value="draw", command=self._change_mode)
        erase_btn = ttk.Radiobutton(frame, text="Erase", variable=self.mode_var, value="erase", command=self._change_mode)
        draw_btn.grid(row=1, column=2)
        erase_btn.grid(row=1, column=3)

        undo_btn = ttk.Button(frame, text="Undo", command=self.undo)
        undo_btn.grid(row=1, column=4, padx=(8,0))
        clear_btn = ttk.Button(frame, text="Clear", command=self.clear)
        clear_btn.grid(row=1, column=5, padx=(8,0))

        save_btn = ttk.Button(frame, text="Save PNG", command=self.save_png)
        save_btn.grid(row=2, column=5, pady=(8,0), sticky="e")

        # Make grid expand the canvas
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

    def _bind_events(self):
        self.canvas.bind("<ButtonPress-1>", self.on_button_press)
        self.canvas.bind("<B1-Motion>", self.on_paint)
        self.canvas.bind("<ButtonRelease-1>", self.on_button_release)
        # optional: support right-click to clear current stroke (not necessary)
        self.root.bind("<Control-z>", lambda e: self.undo())
        self.root.bind("<Control-Z>", lambda e: self.undo())

    def _change_width(self):
        try:
            w = int(self.width_var.get())
            if w > 0:
                self.pen_width = w
        except Exception:
            pass

    def _change_mode(self):
        self.mode = self.mode_var.get()

    def on_button_press(self, event):
        x, y = event.x, event.y
        color = self.pen_color if self.mode == "draw" else self.eraser_color
        width = self.pen_width if self.mode == "draw" else self.eraser_width
        self.current_stroke = {'points': [(x, y)], 'width': width, 'color': color}
        # draw a tiny dot for single-click signatures
        self._draw_dot_on_canvas(x, y, width, color)

    def on_paint(self, event):
        if not self.current_stroke:
            return
        x, y = event.x, event.y
        pts = self.current_stroke['points']
        last = pts[-1]
        pts.append((x, y))
        # draw on canvas
        self.canvas.create_line(last[0], last[1], x, y,
                                width=self.current_stroke['width'],
                                capstyle=tk.ROUND, smooth=True)
        # also draw on PIL image
        self.draw.line([last, (x, y)], fill=self.current_stroke['color'], width=self.current_stroke['width'])

    def on_button_release(self, event):
        if not self.current_stroke:
            return
        # finalize stroke
        self.strokes.append(self.current_stroke)
        self.current_stroke = None

    def _draw_dot_on_canvas(self, x, y, width, color):
        r = max(1, width // 2)
        # canvas dot
        self.canvas.create_oval(x-r, y-r, x+r, y+r, fill=self._rgb_to_hex(color), outline="")
        # PIL dot
        self.draw.ellipse([x-r, y-r, x+r, y+r], fill=color, outline=color)

    def undo(self):
        if not self.strokes:
            return
        self.strokes.pop()
        self._rebuild_image_and_canvas()

    def clear(self):
        if not self.strokes and not self.current_stroke:
            return
        self.strokes = []
        self.current_stroke = None
        self._rebuild_image_and_canvas()

    def _rebuild_image_and_canvas(self):
        # Reset PIL image
        self.image = Image.new("RGBA", (self.width, self.height), self.bg_color)
        self.draw = ImageDraw.Draw(self.image)
        # Clear canvas
        self.canvas.delete("all")
        # Redraw all strokes onto both canvas and PIL image
        for s in self.strokes:
            pts = s['points']
            if not pts:
                continue
            # draw first point as dot if single point
            if len(pts) == 1:
                x, y = pts[0]
                r = max(1, s['width']//2)
                self.canvas.create_oval(x-r, y-r, x+r, y+r, fill=self._rgb_to_hex(s['color']), outline="")
                self.draw.ellipse([x-r, y-r, x+r, y+r], fill=s['color'], outline=s['color'])
                continue
            for i in range(1, len(pts)):
                x1, y1 = pts[i-1]
                x2, y2 = pts[i]
                self.canvas.create_line(x1, y1, x2, y2, width=s['width'], capstyle=tk.ROUND, smooth=True)
                self.draw.line([(x1, y1), (x2, y2)], fill=s['color'], width=s['width'])

    def redraw_canvas(self):
        # initial empty canvas (already white background)
        self.canvas.delete("all")
        self._rebuild_image_and_canvas()

    def save_png(self):
        if not (self.strokes or self.current_stroke):
            if not messagebox.askyesno("Empty", "You haven't drawn anything. Save empty image?"):
                return

        # If the user is currently drawing, finalize that stroke before saving.
        if self.current_stroke:
            self.strokes.append(self.current_stroke)
            self.current_stroke = None

        # Ask for filename
        fpath = filedialog.asksaveasfilename(defaultextension=".png",
                                             filetypes=[("PNG image","*.png")],
                                             title="Save signature as PNG")
        if not fpath:
            return
        try:
            # Rebuild image from strokes to ensure consistency
            self._rebuild_image_and_canvas()
            # Save PNG (RGBA)
            self.image.save(fpath, "PNG")
            messagebox.showinfo("Saved", f"Signature saved to:\n{fpath}")
        except Exception as e:
            messagebox.showerror("Save error", f"Could not save file:\n{e}")

    @staticmethod
    def _rgb_to_hex(rgba):
        r, g, b, a = rgba
        return f'#{r:02x}{g:02x}{b:02x}'

def main():
    root = tk.Tk()
    app = SignatureApp(root, width=900, height=350)
    root.mainloop()

if __name__ == "__main__":
    main()
