"""Render the Jev probability-bar mark at the three required sizes."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SCALE = 4
SIZE = 256 * SCALE
START = 49 * SCALE
END = 207 * SCALE
BAR_HEIGHT = 17 * SCALE


def mix(start: tuple[int, int, int], end: tuple[int, int, int], fraction: float) -> tuple[int, int, int]:
    return tuple(round(a + (b - a) * fraction) for a, b in zip(start, end))


def render() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((10 * SCALE, 10 * SCALE, 246 * SCALE, 246 * SCALE),
                           radius=43 * SCALE, fill="#20252b", outline="#42505b", width=2 * SCALE)

    # Each solid bar runs from zero at the left toward one at the right.
    # Independent probabilities are deliberately unordered from top to bottom.
    for center, probability in ((73, 0.28), (128, 0.91), (183, 0.60)):
        top = center * SCALE - BAR_HEIGHT // 2
        bottom = top + BAR_HEIGHT
        limit = round(START + (END - START) * probability)
        tint = min(1.0, max(0.0, (probability - 0.28) / (0.91 - 0.28)))
        draw.rounded_rectangle((START, top, limit, bottom), radius=BAR_HEIGHT // 2,
                               fill=mix((239, 242, 245), (54, 149, 239), tint))
    return image


def main() -> None:
    image = render()
    for size, path in ((256, ROOT / "assets/logo.png"),
                       (128, ROOT / "vscode-control/icon.png"),
                       (64, ROOT / "assets/icon.png")):
        image.resize((size, size), Image.Resampling.LANCZOS).save(path, optimize=True)


if __name__ == "__main__":
    main()
