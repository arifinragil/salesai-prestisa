import React from 'react';
import { SALES_HANDLING_LABEL } from './enumLabels';

export default function SalesHandlingGrid({ sales_handling }) {
  if (!sales_handling) return null;
  const keys = ['discovery', 'recommendation', 'quotation_quality', 'objection_handling', 'cta', 'follow_up'];
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-sm font-semibold text-gray-700 mb-3">Sales Handling (6 dimensi)</div>
      <div className="grid grid-cols-2 gap-2">
        {keys.map(k => {
          const ok = sales_handling[k];
          return (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className={`inline-block w-5 text-center ${ok ? 'text-green-600' : 'text-red-500'}`}>
                {ok ? '✓' : '✗'}
              </span>
              <span className="text-gray-700">{SALES_HANDLING_LABEL[k] || k}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
