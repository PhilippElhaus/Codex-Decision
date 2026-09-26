"""Generate Codex Jev's icons (development only; requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 256


def p(value):
    return round(value * SCALE)


def box(values):
    return tuple(p(value) for value in values)


def icon(background):
    image = Image.new("RGBA", (p(SIZE), p(SIZE)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if background:
        draw.rounded_rectangle(box((12, 12, 244, 244)), radius=p(55), fill="#192126")

    mint, cyan = "#81d5b4", "#8acdf3"
    draw.rounded_rectangle(box((62, 72, 194, 86)), radius=p(7), fill=cyan)
    draw.line([(p(72), p(104)), (p(119), p(153)), (p(119), p(181))], fill=mint, width=p(13), joint="curve")
    draw.line([(p(184), p(104)), (p(137), p(153)), (p(137), p(181))], fill=mint, width=p(13), joint="curve")
    draw.rounded_rectangle(box((118, 177, 138, 191)), radius=p(7), fill=mint)

    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main():
    target = ROOT / "assets"
    target.mkdir(exist_ok=True)
    icon(True).save(target / "logo.png", optimize=True)
    icon(False).resize((64, 64), Image.Resampling.LANCZOS).save(target / "icon.png", optimize=True)


if __name__ == "__main__":
    main()
