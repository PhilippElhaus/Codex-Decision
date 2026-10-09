"""Stage one self-contained VSIX from the exact release allowlists."""

from pathlib import Path
import shutil
import sys

from verify_packages import CONTROL_FILES, PLUGIN_FILES, ROOT


def stage_control(destination, root=ROOT):
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Integrated control stage already exists")
    destination.mkdir(parents=True)
    mapping = {name: root / "vscode-control" / name for name in CONTROL_FILES}
    mapping.update({"LICENSE": root / "vscode-control/LICENSE",
                    "README.md": root / "vscode-control/README.md"})
    mapping.update({"plugin/" + name: root / name for name in PLUGIN_FILES})
    for relative, source in mapping.items():
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Missing or linked release source: {relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


if __name__ == "__main__":
    stage_control(sys.argv[1])
