declare module 'fossil-delta' {
  export function create(origin: Buffer, target: Buffer): Buffer;
  export function apply(origin: Buffer, delta: Buffer): Buffer;
}
