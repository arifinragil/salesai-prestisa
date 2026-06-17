import React from 'react';
import { PRODUCT_FIT_LABEL } from './enumLabels';

export default function ProductSolutionFitGrid({ product_solution_fit }) {
  if (!product_solution_fit) return null;
  const keys = ['budget', 'timeline', 'occasion', 'customer_profile'];
  const icon = (v) => v === true ? '✓' : v === false ? '✗' : '—';
  const color = (v) => v === true ? 'text-green-600' : v === false ? 'text-red-500' : 'text-gray-400';
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-sm font-semibold text-gray-700 mb-3">Product-Solution Fit (4 dimensi)</div>
      <div className="grid grid-cols-2 gap-2">
        {keys.map(k => {
          const v = product_solution_fit[k];
          return (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className={`inline-block w-5 text-center ${color(v)}`}>{icon(v)}</span>
              <span className="text-gray-700">{PRODUCT_FIT_LABEL[k] || k}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
