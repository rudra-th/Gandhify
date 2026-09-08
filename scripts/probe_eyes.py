import cv2
import numpy as np

SRC = "scripts/raw/gandhi-1931.jpg"

img = cv2.imread(SRC)
h, w = img.shape[:2]
side = min(w, h)
x0 = (w - side) // 2
y0 = (h - side) // 2
crop = img[y0:y0 + side, x0:x0 + side]
gray = cv2.equalizeHist(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
faces = face_cascade.detectMultiScale(gray, 1.12, 5, minSize=(60, 60))
print("all faces:", [(int(x), int(y), int(w_), int(h_)) for (x, y, w_, h_) in faces])
if len(faces):
    fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3]).astype(int)
    print(f"largest face: ({fx},{fy},{fw},{fh}) center=({(fx+fw/2):.0f},{(fy+fh/2):.0f})")
    roi = gray[fy:fy + fh, fx:fx + fw]
    for name, file in [("plain", "haarcascade_eye.xml"), ("with_glasses", "haarcascade_eye_tree_eyeglasses.xml")]:
        c = cv2.CascadeClassifier(cv2.data.haarcascades + file)
        found = None
        for scale, neigh, mins in [(1.05, 3, (15, 15)), (1.1, 4, (12, 12)), (1.03, 2, (10, 10))]:
            eyes = c.detectMultiScale(roi, scale, neigh, minSize=mins)
            if len(eyes) >= 2:
                found = [(fx + ex + ew / 2, fy + ey + eh / 2, ew, eh) for (ex, ey, ew, eh) in eyes[:6]]
                break
        print(name, "->", [(int(x), int(y), int(w2), int(h2)) for (x, y, w2, h2) in found] if found else "none")