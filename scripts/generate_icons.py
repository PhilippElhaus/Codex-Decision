"""Generate the Codex Jev mark (development only; requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 256


def p(value):
    return round(value * SCALE)


def box(values):
    return tuple(p(value) for value in values)


def icon():
    image = Image.new("RGBA", (p(SIZE), p(SIZE)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        box((12, 12, 244, 244)), radius=p(52),
        fill="#1f2328", outline="#343b43", width=p(2),
    )

    # Three lines become one short result. Keep the shape legible at 16 px.
    for left, top, right, bottom, color in (
        (63, 75, 193, 91, "#e5e9ed"),
        (63, 119, 158, 135, "#93a0aa"),
        (63, 163, 118, 179, "#69aff3"),
    ):
        draw.rounded_rectangle(box((left, top, right, bottom)), radius=p(8), fill=color)

    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main():
    target = ROOT / "assets"
    target.mkdir(exist_ok=True)
    mark = icon()
    mark.save(target / "logo.png", optimize=True)
    mark.resize((64, 64), Image.Resampling.LANCZOS).save(target / "icon.png", optimize=True)
    mark.resize((128, 128), Image.Resampling.LANCZOS).save(ROOT / "vscode-control" / "icon.png", optimize=True)


if __name__ == "__main__":
    main()
