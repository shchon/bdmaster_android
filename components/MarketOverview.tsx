import React from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { BondData } from '../types';

interface Props {
  data: BondData[];
}

const MarketOverview: React.FC<Props> = ({ data }) => {
  return (
    <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
      <h3 className="text-xl font-bold text-white mb-4">市场双低分布图 (价格 vs 溢价率)</h3>
      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart
            margin={{ top: 20, right: 20, bottom: 20, left: 20 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis 
              type="number" 
              dataKey="price" 
              name="价格" 
              unit="元" 
              domain={['auto', 'auto']}
              stroke="#94a3b8"
            />
            <YAxis 
              type="number" 
              dataKey="premiumRate" 
              name="溢价率" 
              unit="%" 
              stroke="#94a3b8"
            />
            <Tooltip 
              cursor={{ strokeDasharray: '3 3' }} 
              contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #475569', color: '#f8fafc' }}
            />
             {/* Reference line for "Double Low" strategy visualization - roughly price + premium = 130 */}
            <ReferenceLine y={0} stroke="#475569" />
            <Scatter name="Bonds" data={data} fill="#8884d8">
              {data.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={entry.doubleLow < 115 ? '#22c55e' : (entry.doubleLow > 150 ? '#ef4444' : '#60a5fa')} 
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-center gap-6 mt-4 text-sm text-slate-400">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-green-500"></span>
          <span>低估/买入区 (双低 &lt; 115)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-blue-400"></span>
          <span>中性区</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-red-500"></span>
          <span>高估/风险区 (双低 &gt; 150)</span>
        </div>
      </div>
    </div>
  );
};

export default MarketOverview;