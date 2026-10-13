"""Python port of the portable sin/cos in ../visualhash.js (used by the v3 seed).

Same constants, same operations, same order. Python floats are IEEE 754 doubles
with correctly rounded + - * / and no fused multiply-add, so these functions
return bit-identical results to the JavaScript version. Ports to other languages
must also keep the order and avoid FMA contraction (e.g. in Go, wrap products in
explicit float64() conversions; in C, compile with -ffp-contract=off).

    python 3d/test/portable_trig.py FILE   # FILE: float64 LE triples x, sin(x), cos(x)
"""
import math
import struct
import sys

INV_PIO2 = 6.36619772367581382433e-1
PIO2_1 = 1.57079632673412561417e0
PIO2_1T = 6.07710050650619224932e-11

S1 = -1.66666666666666324348e-1
S2 = 8.33333333332248946124e-3
S3 = -1.98412698298579493134e-4
S4 = 2.75573137070700676789e-6
S5 = -2.50507602534068634195e-8
S6 = 1.58969099521155010221e-10

C1 = 4.16666666666666019037e-2
C2 = -1.38888888888741095749e-3
C3 = 2.48015872894767294178e-5
C4 = -2.75573143513906633035e-7
C5 = 2.08757232129817482790e-9
C6 = -1.13596475577881948265e-11


def kernel_sin(x):
    z = x * x
    v = z * x
    r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
    return x + v * (S1 + z * r)


def kernel_cos(x):
    z = x * x
    r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))))
    hz = 0.5 * z
    w = 1.0 - hz
    return w + (((1.0 - w) - hz) + z * r)


def reduce(x):
    n = float(math.floor(x * INV_PIO2 + 0.5))
    return int(n) % 4, (x - n * PIO2_1) - n * PIO2_1T


def psin(x):
    q, y = reduce(x)
    return (kernel_sin(y), kernel_cos(y), -kernel_sin(y), -kernel_cos(y))[q]


def pcos(x):
    q, y = reduce(x)
    return (kernel_cos(y), -kernel_sin(y), -kernel_cos(y), kernel_sin(y))[q]


if __name__ == "__main__":
    data = open(sys.argv[1], "rb").read()
    bad = 0
    count = len(data) // 24
    for i in range(count):
        x, s, c = struct.unpack_from("<3d", data, i * 24)
        if struct.pack("<2d", psin(x), pcos(x)) != struct.pack("<2d", s, c):
            bad += 1
            if bad <= 5:
                print("MISMATCH", x.hex(), psin(x).hex(), s.hex(), pcos(x).hex(), c.hex())
    print("python bit-exact:", count - bad, "/", count)
    sys.exit(1 if bad else 0)
