import { nativeImage, type NativeImage } from 'electron';
import { renderTrayIconBitmap } from './tray-icon-bitmap.js';

export function createDesktopTrayIcon(): NativeImage {
  const rendered = renderTrayIconBitmap();
  const image = nativeImage.createFromBuffer(rendered.buffer, {
    width: rendered.pixelWidth,
    height: rendered.pixelHeight,
    scaleFactor: rendered.scale,
  });
  image.setTemplateImage(true);
  return image;
}
