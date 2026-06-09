from PIL import Image

# Open the first generated logo (the "V")
img_path = '/home/sahil-padole/.gemini/antigravity/brain/3711dfaa-a55c-4293-a898-663b818e4060/veritas_pro_logo_1781003019635.png'
img = Image.open(img_path).convert("RGBA")

data = img.getdata()
new_data = []
# The background is approximately #0f172a (R=15, G=23, B=42)
# We will make anything close to that transparent.
# Actually, the easiest way is to just use mix-blend-mode: screen in CSS for pure black backgrounds!
# But let's try to make the background pure black first, so mix-blend-mode or just blending works.
# Or better, just crop it tightly first.
