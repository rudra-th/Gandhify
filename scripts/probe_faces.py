import cv2
import numpy as np
import sys

SRC = "scripts/raw/gandhi-1931.jpg"
CROP_SIZE = 256

img = cv2.imread(SRC)
h, w = img.shape[:2]
side = min(w, h)
x0 = (w - side) // 2
y0 = (h - side) // 2
crop = img[y0:y0 + side, x0:x0 + side]
print(f"crop: {crop.shape[1]}x{crop.shape[0]}")

def detect(gray, scale_factor, min_neighbors, min_size):
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + gray)
    return cascade

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")
prof_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")

gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
gray = cv2.equalizeHist(gray)

faces = face_cascade.detectMultiScale(gray, 1.15, 6, minSize=(80, 80))
if len(faces) == 0:
    faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(60, 60))
print("frontal faces:", [(int(x), int(y), int(w_), int(h_)) for (x, y, w_, h_) in faces])

for (fx, fy, fw, fh) in faces:
    roi = gray[fy:fy + fh, fx:fx + fw]
    eyes = eye_cascade.detectMultiScale(roi, 1.12, 5, minSize=(10, 10))
    print(f"  face=({fx},{fy},{fw},{fh}) eyes(in face):", [(int(x), int(y), int(w_), int(h_)) for (x, y, w_, h_) in eyes])

profiles = prof_cascade.detectMultiScale(gray, 1.12, 5, minSize=(60, 60))
print("profile faces:", [(int(x), int(y), int(w_), int(h_)) for (x, y, w_, h_) in profiles])