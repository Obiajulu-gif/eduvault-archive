export async function getCroppedImageBlob(imageSrc, cropAreaPixels, fileType = 'image/jpeg') {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create canvas context for thumbnail cropping');
  }

  canvas.width = cropAreaPixels.width;
  canvas.height = cropAreaPixels.height;

  context.drawImage(
    image,
    cropAreaPixels.x,
    cropAreaPixels.y,
    cropAreaPixels.width,
    cropAreaPixels.height,
    0,
    0,
    cropAreaPixels.width,
    cropAreaPixels.height,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to generate cropped thumbnail'));
        return;
      }
      resolve(blob);
    }, fileType, 0.92);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load selected thumbnail image'));
    image.src = src;
  });
}
