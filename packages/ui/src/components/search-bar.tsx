import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({ value, onChange }) => {
  return (
    <label className="search-bar">
      <span>Search</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Type to filter channels"
      />
    </label>
  );
};
