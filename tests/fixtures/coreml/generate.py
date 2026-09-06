"""Generate the CoreML fixtures the runtime spike loads.

Run with:

    uvx --with coremltools --with numpy python3 tests/fixtures/coreml/generate.py

The model is a single matrix multiply, which is enough to prove the runtime path:
compile, load, feed, predict, read back. Committing the generator rather than the
compiled package keeps a platform-specific binary out of the tree, and the test skips
when the output is absent so a machine without coremltools still runs the suite.
"""

import os
import numpy as np
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


# A convolution, which is the shape the Neural Engine is built for. Generated so the
# placement test has something that could plausibly land there, rather than only a
# matmul that never would.
@mb.program(input_specs=[mb.TensorSpec(shape=(1, 64, 32, 32))])
def conv_program(x):
    import numpy as np

    weight = np.random.default_rng(0).standard_normal((64, 64, 3, 3)).astype(np.float32)
    return mb.conv(x=x, weight=weight, pad_type="same", strides=[1, 1])


conv = ct.convert(
    conv_program,
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.CPU_AND_NE,
    compute_precision=ct.precision.FLOAT16,
)
conv_out = os.path.join(HERE, "conv.mlpackage")
conv.save(conv_out)
print(f"wrote {conv_out}")


# A stack at the size a real layer uses, in the shape this engine emits: matrix
# multiplies with activations, float16 in and out. Size is the variable that decides
# Neural Engine placement — the single tiny operations above stay on the CPU, and this
# does not — so the suite needs one of each to say anything about placement at all.
@mb.program(input_specs=[mb.TensorSpec(shape=(256, 768))])
def stack_program(x):
    import numpy as np

    rng = np.random.default_rng(0)
    for _ in range(8):
        weight = rng.standard_normal((768, 768)).astype(np.float32) * 0.02
        x = mb.matmul(x=x, y=weight)
        x = mb.relu(x=x)
    return x


stack = ct.convert(
    stack_program,
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.CPU_AND_NE,
    compute_precision=ct.precision.FLOAT16,
    inputs=[ct.TensorType(name="x", shape=(256, 768), dtype=np.float16)],
    outputs=[ct.TensorType(dtype=np.float16)],
)
stack_out = os.path.join(HERE, "stack.mlpackage")
stack.save(stack_out)
print(f"wrote {stack_out}")


# The same arithmetic with every weight arriving as an input rather than baked in at
# conversion time. That is the shape a recorded tensor graph hands over — activations
# times weight tensors — and whether it still reaches the Neural Engine decides whether
# a compiled region survives a weight update or has to be rebuilt every step.
_runtime_specs = [mb.TensorSpec(shape=(256, 768))] + [
    mb.TensorSpec(shape=(768, 768)) for _ in range(8)
]


@mb.program(input_specs=_runtime_specs)
def runtime_program(x, w0, w1, w2, w3, w4, w5, w6, w7):
    for weight in (w0, w1, w2, w3, w4, w5, w6, w7):
        x = mb.matmul(x=x, y=weight)
        x = mb.relu(x=x)
    return x


runtime = ct.convert(
    runtime_program,
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.CPU_AND_NE,
    compute_precision=ct.precision.FLOAT16,
    inputs=[ct.TensorType(name="x", shape=(256, 768), dtype=np.float16)]
    + [ct.TensorType(name=f"w{i}", shape=(768, 768), dtype=np.float16) for i in range(8)],
    outputs=[ct.TensorType(dtype=np.float16)],
)
runtime_out = os.path.join(HERE, "runtime-weights.mlpackage")
runtime.save(runtime_out)
print(f"wrote {runtime_out}")


# The same shape again at 1024 a side. Size is what selects this engine's kernels: below
# 1024 the cooperative-matrix GEMM does not engage and the smaller tiling is chosen, so a
# comparison held only at 256x768 measures CoreML against the slower of two paths this
# engine has. Whether the Neural Engine still wins where our best kernel runs is a
# different question from whether it wins at all, and the backend decision needs both.
_wide_specs = [mb.TensorSpec(shape=(1024, 1024))] + [
    mb.TensorSpec(shape=(1024, 1024)) for _ in range(8)
]


@mb.program(input_specs=_wide_specs)
def wide_program(x, w0, w1, w2, w3, w4, w5, w6, w7):
    for weight in (w0, w1, w2, w3, w4, w5, w6, w7):
        x = mb.matmul(x=x, y=weight)
        x = mb.relu(x=x)
    return x


wide = ct.convert(
    wide_program,
    minimum_deployment_target=ct.target.iOS16,
    compute_units=ct.ComputeUnit.CPU_AND_NE,
    compute_precision=ct.precision.FLOAT16,
    inputs=[ct.TensorType(name="x", shape=(1024, 1024), dtype=np.float16)]
    + [ct.TensorType(name=f"w{i}", shape=(1024, 1024), dtype=np.float16) for i in range(8)],
    outputs=[ct.TensorType(dtype=np.float16)],
)
wide_out = os.path.join(HERE, "runtime-weights-1024.mlpackage")
wide.save(wide_out)
print(f"wrote {wide_out}")
