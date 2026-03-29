const MAX_CONCURRENT_AUDIO = 3;

let activeCount = 0;
const waitQueue: Array<() => void> = [];

export async function acquireAudioSemaphore(): Promise<void> {
  if (activeCount < MAX_CONCURRENT_AUDIO) {
    activeCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
  });
  activeCount++;
}

export function releaseAudioSemaphore(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) next();
}
