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

    # The track spans zero at the left to one at the right. The bars represent
    # independent, deliberately unordered probabilities.
    for center, probability in ((73, 0.42), (128, 0.89), (183, 0.64)):
        top = center * SCALE - BAR_HEIGHT // 2
        bottom = top + BAR_HEIGHT
        draw.rounded_rectangle((START, top, END, bottom), radius=BAR_HEIGHT // 2,
                               fill="#62707b")
        limit = round(START + (END - START) * probability)
        gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        pixels = ImageDraw.Draw(gradient)
        for x in range(START, limit + 1):
            fraction = (x - START) / (END - START)
            pixels.line((x, top, x, bottom), fill=(*mix((239, 242, 245), (54, 149, 239), fraction), 255))
        mask = Image.new("L", (SIZE, SIZE), 0)
        ImageDraw.Draw(mask).rounded_rectangle((START, top, limit, bottom),
                                                radius=BAR_HEIGHT // 2, fill=255)
        image.paste(gradient, (0, 0), mask)
    return image


def main() -> None:
    image = render()
    for size, path in ((256, ROOT / "assets/logo.png"),
                       (128, ROOT / "vscode-control/icon.png"),
                       (64, ROOT / "assets/icon.png")):
        image.resize((size, size), Image.Resampling.LANCZOS).save(path, optimize=True)


if __name__ == "__main__":
    main()
