export const log = (...a: any[]) => console.log(new Date().toISOString(), '-', ...a);
export const warn = (...a: any[]) => console.warn(new Date().toISOString(), '[WARN]', ...a);
export const error = (...a: any[]) => console.error(new Date().toISOString(), '[ERROR]', ...a);
