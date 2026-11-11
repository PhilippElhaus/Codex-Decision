"""Expose native runtime and CLI fingerprints to Nx's full-suite cache."""
import json

from common import environment, prepare_native_cli

prepare_native_cli()
print(json.dumps(environment("nx"), sort_keys=True))
