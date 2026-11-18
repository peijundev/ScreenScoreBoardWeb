import { useEffect, useState, type JSX } from 'react';
import { subscribeToast } from '../../shared/ui';

interface ToastItem {
  id: number;
  message: string;
}

let seq = 0;

export default function Toasts(): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToast((message) => {
      const item = { id: ++seq, message };
      setItems((prev) => [...prev, item]);
      setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
      }, 3200);
    });
  }, []);

  return (
    <>
      {items.map((item) => (
        <div key={item.id} className="toast">
          {item.message}
        </div>
      ))}
    </>
  );
}
