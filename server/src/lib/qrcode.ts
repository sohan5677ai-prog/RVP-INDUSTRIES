import QRCode from 'qrcode';

export async function qrPngBuffer(data: string, size = 250): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: 'png', width: size, margin: 1 });
}
