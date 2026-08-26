# 生成番茄闹钟图标：番茄 + 表盘 + 10:10 指针
from PIL import Image, ImageDraw
import math, os

S = 256
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# ---- 番茄主体 ----
d.ellipse([42, 70, 214, 238], fill=(230, 74, 56, 255))        # 主体红
d.ellipse([70, 100, 140, 158], fill=(248, 130, 108, 130))      # 高光

# ---- 叶子与茎 ----
d.polygon([(128, 80), (92, 26), (148, 58)], fill=(52, 199, 89, 255))
d.polygon([(128, 80), (164, 24), (110, 56)], fill=(34, 171, 92, 255))
d.rectangle([122, 34, 134, 82], fill=(34, 171, 92, 255))       # 茎

# ---- 表盘 ----
cx, cy, r = 128, 154, 60
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255), outline=(55, 55, 55, 255), width=10)
# 四个刻度点
for mx, my in [(cx, cy - r + 14), (cx + r - 14, cy), (cx, cy + r - 14), (cx - r + 14, cy)]:
    d.ellipse([mx - 4, my - 4, mx + 4, my + 4], fill=(55, 55, 55, 255))

# ---- 指针（10:10）----
def hand(angle_clockwise, length, width):
    rad = math.radians(angle_clockwise) - math.pi / 2
    ex = cx + length * math.cos(rad)
    ey = cy + length * math.sin(rad)
    d.line([cx, cy, ex, ey], fill=(45, 45, 45, 255), width=width)

hand(-60, 27, 10)   # 时针 → 10 点方向
hand(60, 42, 7)     # 分针 → 2 点方向
d.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=(45, 45, 45, 255))  # 中心轴

os.makedirs(OUT, exist_ok=True)
img.save(os.path.join(OUT, 'icon.png'))
img.save(os.path.join(OUT, 'icon.ico'),
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('OK ->', os.path.join(OUT, 'icon.ico'))
