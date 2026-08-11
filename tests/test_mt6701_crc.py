def crc6(data):
    crc = 0x00
    for bit in range(18):
        crc ^= (data >> (17 - bit)) & 1
        if crc & 1:
            crc = ((crc >> 1) ^ 0x30) & 0x3F
        else:
            crc = (crc >> 1) & 0x3F
    reflected = 0
    for bit in range(6):
        if crc & (1 << bit):
            reflected |= 1 << (5 - bit)
    return reflected


def test_crc6_reference_vectors():
    assert crc6(0x000000) == 0x00
    assert crc6(0x000001) == 0x03
    assert crc6(0x0003FF) == 0x31
    assert crc6(0x0AAAAA) == 0x35
    assert crc6(0x3FFFFF) == 0x0E
    assert crc6(0x00DE20) == 0x36
    assert crc6(0x00B160) == 0x18
    assert crc6(0x00B170) == 0x28
