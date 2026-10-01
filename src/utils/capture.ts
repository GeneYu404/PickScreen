/** 调用浏览器原生屏幕捕获 API，获取一帧真实屏幕画面 */
export async function captureScreen(): Promise<{ dataUrl: string; width: number; height: number }> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('当前浏览器不支持屏幕捕获，请使用 Edge 或 Chrome。');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => video.play().then(resolve);
  });
  await new Promise((r) => setTimeout(r, 150));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0);
  stream.getTracks().forEach((t) => t.stop());
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}
