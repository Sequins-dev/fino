"""Generate the CoreML fixtures the runtime spike loads.

Run with:

    uvx --with coremltools --with numpy python3 tests/fixtures/coreml/generate.py

The model is a single matrix multiply, which is enough to prove the runtime path:
compile, load, feed, predict, read back. Committing the generator rather than the
compiled package keeps a platform-specific binary out of the tree, and the test skips
when the output is absent so a machine without coremltools still runs the suite.
"""

import os
import coremltools as ct
from coremltools.converters.mil import Builder as mb

HERE = os.path.dirname(os.path.abspath(__file__))


@mb.program(input_specs=[mb.TensorSpec(shape=(1, 256)), mb.TensorSpec(shape=(256, 256))])
def matmul_program(x, w):
    return mb.matmul(x=x, y=w)


model = ct.convert(
    matmul_program,
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.CPU_AND_NE,
    compute_precision=ct.precision.FLOAT16,
)
out = os.path.join(HERE, "matmul.mlpackage")
model.save(out)
print(f"wrote {out}")
