from PIL import Image, ImageChops

def trim(im):
    bg = Image.new(im.mode, im.size, im.getpixel((0,0)))
    diff = ImageChops.difference(im, bg)
    diff = ImageChops.add(diff, diff, 2.0, -100)
    bbox = diff.getbbox()
    if bbox:
        return im.crop(bbox)
    return im

img = Image.open('public/logo.png')
if img.mode != 'RGB':
    img = img.convert('RGB')
cropped = trim(img)
w, h = cropped.size
# Let's make it square
size = max(w, h)
pad_w = (size - w) // 2
pad_h = (size - h) // 2
square = Image.new('RGB', (size, size), img.getpixel((0,0)))
square.paste(cropped, (pad_w, pad_h))

# add small padding
pad = int(size * 0.02)
final = Image.new('RGB', (size + 2*pad, size + 2*pad), img.getpixel((0,0)))
final.paste(square, (pad, pad))

final.save('public/logo.png')
print("Cropped successfully")
