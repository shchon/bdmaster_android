import React from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import { BondData } from '../types';

interface Props {
  bond: BondData | null;
  analysis: string | null;
  loading: boolean;
  onClose: () => void;
}

const AIAnalysisPanel: React.FC<Props> = ({ bond, analysis, loading, onClose }) => {
  if (!bond) return null;

  return (
    <div className="fixed bottom-4 right-4 w-full max-w-md bg-slate-800 border border-purple-500/50 rounded-xl shadow-2xl overflow-hidden z-50 animate-fade-in-up">
      <div className="bg-slate-900 p-4 flex justify-between items-center border-b border-slate-700">
        <div className="flex items-center gap-2 text-purple-400">
          <Bot size={20} />
          <h3 className="font-bold">Gemini 智能分析: {bond.name}</h3>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
          <X size={18} />
        </button>
      </div>
      
      <div className="p-5 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4 text-slate-400">
            <Loader2 className="animate-spin text-purple-500" size={32} />
            <p>正在分析技术指标...</p>
          </div>
        ) : (
          <div className="prose prose-invert prose-sm">
             {/* Simple renderer for the markdown text */}
             <div className="text-slate-200 whitespace-pre-wrap leading-relaxed">
               {analysis?.split('\n').map((line, i) => {
                 // Basic manual markdown parsing for bold text
                 const parts = line.split('**');
                 return (
                   <p key={i} className="mb-2">
                     {parts.map((part, index) => 
                        index % 2 === 1 ? <strong key={index} className="text-purple-300 font-bold">{part}</strong> : part
                     )}
                   </p>
                 )
               })}
             </div>
          </div>
        )}
      </div>
      <div className="bg-slate-900/50 p-2 text-center text-xs text-slate-500">
        AI生成内容仅供参考，不构成投资建议
      </div>
    </div>
  );
};

export default AIAnalysisPanel;