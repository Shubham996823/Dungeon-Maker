from pathlib import Path
from psd_tools import PSDImage

SOURCE = Path(r"C:\Users\shubh\Downloads\Telegram Desktop\Essential Rock Brushes Vol1\Essential Rock Brushes Vol1\Alphas")
TARGET = Path(r"C:\Users\shubh\Downloads\Telegram Desktop\Essential Rock Brushes Vol1\Essential Rock Brushes Vol1\Alpha Png")

TARGET.mkdir(parents=True, exist_ok=True)
converted = []
for psd_path in sorted(SOURCE.glob("*.psd")):
    image = PSDImage.open(psd_path).composite(force=True)
    image.save(TARGET / f"{psd_path.stem}.png", format="PNG")
    converted.append(psd_path.stem)

print(f"Converted {len(converted)} PSD files to {TARGET}")
