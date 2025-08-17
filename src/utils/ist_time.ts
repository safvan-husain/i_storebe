export const getIndianTime = (): Date => {
  const now = new Date();
  const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  return new Date(istString);
};

export const getISTDate = (): Date => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // Convert 5.5 hours to milliseconds
    return new Date(now.getTime() + istOffset);
};
const istUtcOffset = 19800000;

export const convertToIstMillie = (data: Date): number => data.getTime() + istUtcOffset;