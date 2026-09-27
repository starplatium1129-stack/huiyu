import { digest } from './media';

// The producer and GC must recognize the same staging identities after a restart.
export const taskInputStagingKey = (taskId: string, name: string): string => digest(`input:${taskId}:${name}`);
export const taskOutputStagingKey = (taskId: string, index: number): string => digest(`task:${taskId}:${index}`);
